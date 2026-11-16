import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  createMockUpstream,
  DEFAULT_RELAY_STACK_PORT,
  MOCK_UPSTREAM_BODY,
  parseRelayStackArgs,
  relayStackPorts,
  relayWorkerCommand,
} from '../scripts/relay-stack.ts';

// P4-S2: the relay's local stack and its API description, which the relay-zap job scans.
// The relay package is read as files, never imported: one package does not import another.

/** A wrangler config: JSON with comments and trailing commas, read the way tsconfig is. */
function readJsonc(path: string): Record<string, unknown> {
  const parsed: { config?: unknown; error?: unknown } = ts.parseConfigFileTextToJson(
    path,
    readFileSync(path, 'utf8'),
  );
  if (parsed.error !== undefined) throw new Error(`${path} does not parse`);
  return parsed.config as Record<string, unknown>;
}

/** The keys of `ERROR_CODES` in handler.ts, in source order. */
function handlerErrorCodes(): string[] {
  const source = readFileSync('workers/relay/src/handler.ts', 'utf8');
  const block = /export const ERROR_CODES = \{\n([\s\S]*?)\n\} as const;/.exec(source)?.[1];
  if (block === undefined) throw new Error('ERROR_CODES not found in handler.ts');
  return block.split('\n').map((line) => {
    const code = /^ {2}([a-z_]+): \d{3},$/.exec(line)?.[1];
    if (code === undefined) throw new Error(`unexpected ERROR_CODES line: ${line}`);
    return code;
  });
}

interface OpenApi {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: { Error: { properties: { error: { enum: string[] } } } } };
}

const openapi = JSON.parse(readFileSync('workers/relay/openapi.json', 'utf8')) as OpenApi;

test('openapi.json is OpenAPI 3.1 and describes exactly the four relay paths', () => {
  expect(openapi.openapi).toMatch(/^3\.1\.\d+$/);
  expect(Object.keys(openapi.paths).sort()).toEqual([
    '/v1/fetch',
    '/v1/healthz',
    '/v1/quota/{source}',
    '/v1/session',
  ]);
  expect(Object.keys(openapi.paths['/v1/quota/{source}'] ?? {})).toEqual(['get']);
  expect(Object.keys(openapi.paths['/v1/fetch'] ?? {}).sort()).toEqual(['get', 'post']);
  expect(Object.keys(openapi.paths['/v1/session'] ?? {})).toEqual(['post']);
  expect(Object.keys(openapi.paths['/v1/healthz'] ?? {})).toEqual(['get']);
});

test('the error enum is exactly the codes handler.ts answers', () => {
  const codes = handlerErrorCodes();
  expect(codes).toContain('not_configured');
  expect(openapi.components.schemas.Error.properties.error.enum).toEqual(codes);
});

test('the only server a scanner is pointed at is the local stack', () => {
  expect(openapi.servers.map((server) => server.url)).toEqual([
    `http://127.0.0.1:${String(DEFAULT_RELAY_STACK_PORT)}`,
  ]);
});

test('the stack config has no route and runs the stack entry; production runs src/index.ts', () => {
  const stack = readJsonc('workers/relay/wrangler.stack.jsonc');
  expect(stack).not.toHaveProperty('routes');
  expect(stack).not.toHaveProperty('route');
  expect(stack['main']).toBe('./tests/stack-entry.ts');
  expect(stack['name']).not.toBe('relay');

  const production = readJsonc('workers/relay/wrangler.jsonc');
  expect(production['main']).toBe('./src/index.ts');
});

test('production pins invocation logs and tracing off: both would record the request URL', () => {
  const production = readJsonc('workers/relay/wrangler.jsonc');
  const observability = production['observability'] as {
    logs?: { invocation_logs?: unknown };
    traces?: { enabled?: unknown };
  };
  expect(observability.logs?.invocation_logs).toBe(false);
  expect(observability.traces?.enabled).toBe(false);
});

test('the X-Relay-Target maxLength in openapi.json is MAX_TARGET_LENGTH in target.ts', () => {
  const source = readFileSync('workers/relay/src/target.ts', 'utf8');
  const max = /export const MAX_TARGET_LENGTH = (\d+);/.exec(source)?.[1];
  expect(max).toBeDefined();
  const target = (
    openapi as unknown as {
      components: { parameters: { Target: { schema: { maxLength: number } } } };
    }
  ).components.parameters.Target;
  expect(target.schema.maxLength).toBe(Number(max));
});

test('the stack entry exports its handler and nothing else', () => {
  // workerd reads every named export of an entry as an entrypoint and refuses to start on a constant.
  const entry = readFileSync('workers/relay/tests/stack-entry.ts', 'utf8');
  expect(entry.match(/^export /gm)).toEqual(['export ']);
  expect(entry).toMatch(/^export default \{$/m);
});

test('the default ports are the relay, the mock upstream and an inspector of its own', () => {
  expect(parseRelayStackArgs([])).toEqual({ port: 8795 });
  expect(relayStackPorts(8795)).toEqual({ relay: 8795, upstream: 8796, inspector: 9231 });
  expect(parseRelayStackArgs(['--port', '9000'])).toEqual({ port: 9000 });
  for (const bad of ['80', '65535', 'x', '8795.5']) {
    expect(() => parseRelayStackArgs(['--port', bad]), bad).toThrow(/--port/);
  }
});

test('wrangler dev runs the stack config locally, with its inspector port and loopback vars', () => {
  const command = relayWorkerCommand(8795);
  expect(command).toContain('wrangler dev --config wrangler.stack.jsonc');
  expect(command).toContain('--port 8795');
  expect(command).toContain('--inspector-port 9231');
  expect(command).toContain('--ip 127.0.0.1');
  expect(command).toContain('--local');
  expect(command).toContain('--var SITE:http://127.0.0.1:8795');
  expect(command).toContain('--var UPSTREAM:http://127.0.0.1:8796');
});

let upstream: http.Server;
let base: string;

beforeAll(async () => {
  upstream = createMockUpstream();
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((done) => upstream.close(done));
});

test('the mock upstream answers every path with one fixed JSON body', async () => {
  for (const path of ['/ok', '/v1/models?q=<script>', '/']) {
    const response = await fetch(`${base}${path}`);
    expect(response.status, path).toBe(200);
    expect(response.headers.get('content-type'), path).toBe('application/json; charset=utf-8');
    expect(await response.text(), path).toBe(MOCK_UPSTREAM_BODY);
  }
  const posted = await fetch(`${base}/ok`, { method: 'POST', body: 'x'.repeat(1000) });
  expect(await posted.text()).toBe(MOCK_UPSTREAM_BODY);
});

test('--count-file is passed through and an empty path is refused', () => {
  expect(parseRelayStackArgs(['--count-file', 'hits.txt'])).toEqual({
    port: 8795,
    countFile: 'hits.txt',
  });
  expect(() => parseRelayStackArgs(['--count-file', ''])).toThrow(/--count-file/);
});

test('with a count file the mock writes 0 at once and the running count after each answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-stack-count-'));
  const countFile = join(dir, 'count.txt');
  const counted = createMockUpstream({ countFile });
  try {
    expect(readFileSync(countFile, 'utf8')).toBe('0\n');
    await new Promise<void>((done) => counted.listen(0, '127.0.0.1', done));
    const at = `http://127.0.0.1:${String((counted.address() as AddressInfo).port)}`;
    await (await fetch(`${at}/ok`)).text();
    expect(readFileSync(countFile, 'utf8')).toBe('1\n');
    await (await fetch(`${at}/a`, { method: 'POST', body: '{}' })).text();
    await (await fetch(`${at}/b`, { method: 'HEAD' })).text();
    expect(readFileSync(countFile, 'utf8')).toBe('3\n');
  } finally {
    await new Promise((done) => counted.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});
