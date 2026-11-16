import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { createHandler, type LogEntry } from '../src/handler.ts';
import { STACK_HOST, stackDeps, type StackEnv, TURNSTILE_DUMMY_TOKEN } from './stack-deps.ts';

// What the relay-zap scan runs against (stack-entry.ts): the real handler, with an upstream
// that is a local mock and nothing that can reach a real host.

const UPSTREAM_BODY = '{"from":"mock"}';
const seen: string[] = [];
let mock: http.Server;
let env: StackEnv;

beforeAll(async () => {
  mock = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(UPSTREAM_BODY);
  });
  await new Promise<void>((done) => mock.listen(0, '127.0.0.1', done));
  const port = (mock.address() as AddressInfo).port;
  env = { SITE: 'http://127.0.0.1:8795', UPSTREAM: `http://127.0.0.1:${String(port)}` };
});

afterAll(async () => {
  await new Promise((done) => mock.close(done));
});

function handler() {
  const logs: LogEntry[] = [];
  const handle = createHandler(stackDeps(env, (entry) => logs.push(entry)));
  const ctx = { waitUntil: () => undefined };
  return { logs, send: (request: Request) => handle(request, ctx) };
}

function sessionRequest(token: string): Request {
  return new Request('http://127.0.0.1:8795/v1/session', {
    method: 'POST',
    headers: { origin: env.SITE, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function session(send: (request: Request) => Promise<Response>): Promise<string> {
  const response = await send(sessionRequest(TURNSTILE_DUMMY_TOKEN));
  expect(response.status).toBe(200);
  return (await response.json<{ session: string }>()).session;
}

function fetchRequest(target: string, token: string): Request {
  return new Request('http://127.0.0.1:8795/v1/fetch', {
    headers: { origin: env.SITE, 'x-relay-target': target, 'x-relay-session': token },
  });
}

test('the allowlist is the mock host alone', () => {
  const deps = stackDeps(env, () => undefined);
  expect([...deps.hosts]).toEqual([STACK_HOST]);
  expect(deps.origin).toBe(env.SITE);
});

test('the Turnstile dummy token mints a session and any other token is refused', async () => {
  const { send } = handler();
  expect((await session(send)).startsWith('v1.')).toBe(true);
  const refused = await send(sessionRequest('a-real-looking-token'));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: 'turnstile_failed' });
});

test('a fetch to the mock host is relayed to the local upstream, path and query intact', async () => {
  const { send } = handler();
  const token = await session(send);
  const response = await send(fetchRequest(`https://${STACK_HOST}/ok?n=1`, token));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(UPSTREAM_BODY);
  expect(seen).toContain('/ok?n=1');
});

test('any other host is refused before anything is fetched', async () => {
  const { send } = handler();
  const token = await session(send);
  const before = seen.length;
  const response = await send(fetchRequest('https://evil.test/', token));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'host_not_allowed' });
  expect(seen).toHaveLength(before);
});

test('the injected fetch and resolver reach the mock host only', async () => {
  const deps = stackDeps(env, () => undefined);
  await expect(deps.fetch(new URL('https://example.com/'))).rejects.toThrow(/upstream\.test/);
  await expect(deps.fetch(new URL(`http://${STACK_HOST}/ok`))).rejects.toThrow(/upstream\.test/);
  expect(await deps.resolve(STACK_HOST)).toEqual({ ok: true });
  expect(await deps.resolve('example.com')).toEqual({ ok: false });
});

test('an upstream that is not a loopback address is refused at build time', () => {
  expect(() => stackDeps({ ...env, UPSTREAM: 'https://api.example.com' }, () => undefined)).toThrow(
    /127\.0\.0\.1/,
  );
  expect(() => stackDeps({ ...env, SITE: 'https://the40thieves.dev' }, () => undefined)).toThrow(
    /127\.0\.0\.1/,
  );
});
