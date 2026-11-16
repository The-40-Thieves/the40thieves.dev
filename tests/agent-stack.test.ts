import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  busyPorts,
  createFrontProxy,
  MCP_ROUTE_PREFIX,
  onProcessEnd,
  parseStackArgs,
  stackPorts,
  upstreamFor,
  workerCommands,
} from '../scripts/agent-stack.ts';

// P3-S5: the conformance suite needs the hub and the `mcp` Worker on one origin, split the
// way the production route splits them. The proxy is the only part of the stack that is ours.

test('paths split the way the production route does', () => {
  for (const path of ['/mcp', '/mcp/', '/mcp/webmcp', '/mcp/server-card', '/mcpx']) {
    expect(upstreamFor(path), path).toBe('mcp');
  }
  for (const path of ['/', '/codecalc/', '/codecalc/mcp', '/manifest.json', '/m', '/MCP']) {
    expect(upstreamFor(path), path).toBe('hub');
  }
});

test('the prefix is the route pattern of the mcp Worker', () => {
  const config = readFileSync('workers/mcp/wrangler.jsonc', 'utf8');
  expect(config).toContain(`"pattern": "the40thieves.dev${MCP_ROUTE_PREFIX}*"`);
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** An upstream that says who it is and echoes what it was sent. */
function echo(name: string): http.Server {
  return http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const seen: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const status = request.url === '/mcp/refused' ? 429 : 200;
      response.writeHead(status, {
        'content-type': 'application/json',
        'x-upstream': name,
        'retry-after': '60',
      });
      response.end(JSON.stringify(seen));
    });
  });
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

const hub = echo('hub');
const mcp = echo('mcp');
let front: http.Server;
let origin: string;

beforeAll(async () => {
  front = createFrontProxy({ hub: await listen(hub), mcp: await listen(mcp) });
  origin = await listen(front);
});

afterAll(async () => {
  await Promise.all([close(front), close(hub), close(mcp)]);
});

test('a request goes to the upstream its path names, query string included', async () => {
  const page = await fetch(`${origin}/codecalc/?x=1`);
  expect(page.headers.get('x-upstream')).toBe('hub');
  expect(((await page.json()) as Seen).url).toBe('/codecalc/?x=1');
  const tools = await fetch(`${origin}/mcp/webmcp`);
  expect(tools.headers.get('x-upstream')).toBe('mcp');
  expect(((await tools.json()) as Seen).url).toBe('/mcp/webmcp');
});

test('method, headers and body reach the upstream unchanged', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      origin: 'https://evil.example',
      'cf-connecting-ip': '2001:db8::1',
    },
    body,
  });
  const seen = (await response.json()) as Seen;
  expect(seen.method).toBe('POST');
  expect(seen.body).toBe(body);
  expect(seen.headers['mcp-protocol-version']).toBe('2026-07-28');
  expect(seen.headers['origin']).toBe('https://evil.example');
  expect(seen.headers['cf-connecting-ip']).toBe('2001:db8::1');
});

test('the upstream status and headers come back as they were', async () => {
  const response = await fetch(`${origin}/mcp/refused`);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('content-type')).toBe('application/json');
});

test('an upstream that is down is a 502 that says which one', async () => {
  const lonely = createFrontProxy({ hub: 'http://127.0.0.1:9', mcp: 'http://127.0.0.1:9' });
  const url = await listen(lonely);
  try {
    const response = await fetch(`${url}/mcp/healthz`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('mcp');
  } finally {
    await close(lonely);
  }
});

// A stack left behind by an interrupted run would answer the readiness probe of the next one,
// which would then be judged against processes it did not start.
test('a port something already listens on is reported as busy, a free one is not', async () => {
  const taken = http.createServer();
  await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
  const { port } = taken.address() as AddressInfo;
  const free = http.createServer();
  await new Promise<void>((done) => free.listen(0, '127.0.0.1', done));
  const freePort = (free.address() as AddressInfo).port;
  await new Promise((done) => free.close(done));
  try {
    expect(await busyPorts([freePort, port])).toEqual([port]);
    expect(await busyPorts([freePort])).toEqual([]);
  } finally {
    await new Promise((done) => taken.close(done));
  }
});

/** A process stand-in: the three events and an `exit` that records its code. */
function fakeProcess() {
  const events = new EventEmitter();
  const exits: number[] = [];
  return Object.assign(events, {
    exits,
    exit(code?: number) {
      exits.push(code ?? 0);
    },
  });
}

test('the stack is cleaned up when the process is interrupted or exits, exactly once', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const target = fakeProcess();
    let cleaned = 0;
    onProcessEnd(() => cleaned++, target);
    target.emit(signal);
    expect(cleaned, signal).toBe(1);
    expect(target.exits, signal).toEqual([130]);
    // The exit that follows the signal does not clean up twice.
    target.emit('exit');
    expect(cleaned, signal).toBe(1);
  }
  const plain = fakeProcess();
  let cleaned = 0;
  onProcessEnd(() => cleaned++, plain);
  plain.emit('exit');
  expect(cleaned).toBe(1);
  expect(plain.exits).toEqual([]);
});

test('after a normal stop the process hooks are gone', () => {
  const target = fakeProcess();
  let cleaned = 0;
  const release = onProcessEnd(() => cleaned++, target);
  release();
  target.emit('SIGINT');
  target.emit('exit');
  expect(cleaned).toBe(0);
  expect(target.exits).toEqual([]);
  expect(target.listenerCount('exit') + target.listenerCount('SIGINT')).toBe(0);
});

test('a stack takes five ports in a row, and none of them twice', () => {
  expect(Object.values(stackPorts(8790))).toEqual([8790, 8791, 8792, 8793, 8794]);
});

// Left to itself each `wrangler dev` picks inspector port 9229; two started together both take
// it, and on Linux the second one dies with "Address already in use".
test('each Worker is started with an inspector port of its own', () => {
  const commands = workerCommands(8790, '/tmp/state');
  expect(commands.hub).toContain('--port 8791 ');
  expect(commands.hub).toContain('--inspector-port 8793 ');
  expect(commands.mcp).toContain('--port 8792 ');
  expect(commands.mcp).toContain('--inspector-port 8794 ');
  expect(commands.mcp).toContain('--persist-to "/tmp/state"');
});

test('the highest port accepted leaves room for all five', () => {
  expect(parseStackArgs(['--port', '65531'])).toEqual({ port: 65_531 });
  expect(() => parseStackArgs(['--port', '65532'])).toThrow('1024 to 65531');
  expect(parseStackArgs([])).toEqual({ port: 8790 });
});
