import { afterEach, describe, expect, test, vi } from 'vitest';

import { createHandler, type Limiter, type RelayDeps } from '../src/handler.ts';
import { RELAY_HOSTS } from '../src/allowlist.ts';
import {
  chunkedBody,
  drain,
  fetchRequest,
  harness,
  HOST,
  NOW,
  SECRET,
  session,
  SITE,
} from './fakes.ts';

/**
 * The "Relay allowlist" gate (P4-S2): one named test per row, all through `createHandler`
 * with fakes.
 */

const CAP = 2 * 1024 * 1024;

afterEach(() => {
  vi.useRealTimers();
});

describe('Relay allowlist gate', () => {
  test('private IP', async () => {
    const h = harness({ resolve: () => Promise.resolve({ ok: false }) });
    const blocked = await h.send(fetchRequest({ session: await session() }));
    expect(blocked.status).toBe(502);
    expect(await blocked.json()).toEqual({ error: 'dns_blocked' });
    expect(h.calls).toHaveLength(0);

    const metadata = await h.send(
      fetchRequest({
        target: 'https://169.254.169.254/latest/meta-data/',
        session: await session(),
      }),
    );
    expect(metadata.status).toBe(403);
    expect(await metadata.json()).toEqual({ error: 'host_not_allowed' });
    expect(h.calls).toHaveLength(0);
  });

  test('redirect to another host', async () => {
    const h = harness({
      answer: () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
        ),
    });
    const response = await h.send(fetchRequest({ session: await session() }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'upstream_redirect' });
    expect(response.headers.has('location')).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  test('oversize body', async () => {
    // The response: 2 097 153 bytes with no content-length error the client stream short of it.
    const big = harness({ answer: () => Promise.resolve(new Response(chunkedBody(CAP + 1))) });
    const response = await big.send(fetchRequest({ session: await session() }));
    expect(response.status).toBe(200);
    const read = await drain(response.body);
    expect(read.error).toBeInstanceOf(Error);
    expect(read.bytes).toBeLessThan(CAP + 1);
    await big.settle();
    expect(big.logs).toEqual([
      expect.objectContaining({ route: 'fetch', outcome: 'too_large', bytes: read.bytes }),
    ]);

    // The request: a declared 65 537 bytes is refused before any upstream call.
    const h = harness();
    const declared = await h.send(
      fetchRequest({
        method: 'POST',
        session: await session(),
        headers: { 'content-length': '65537' },
        body: new Uint8Array(65_537),
      }),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'body_too_large' });

    // And a streamed body with no content-length is cut off at the cap while it is read.
    const streamed = await h.send(
      fetchRequest({ method: 'POST', session: await session(), body: chunkedBody(65_537) }),
    );
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual({ error: 'body_too_large' });
    expect(h.calls).toHaveLength(0);
  });

  test('slow body', async () => {
    const token = await session();
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(100));
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness({ answer: () => Promise.resolve(new Response(stalled)) });
    const response = await h.send(fetchRequest({ session: token }));
    expect(response.status).toBe(200);
    let read: { bytes: number; error: unknown } | undefined;
    void drain(response.body).then((value) => (read = value));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(read).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(read?.bytes).toBe(100);
    expect(read?.error).toBeInstanceOf(Error);
    await h.settle();
    expect(h.logs).toEqual([
      expect.objectContaining({ route: 'fetch', outcome: 'timeout', bytes: 100 }),
    ]);
  });

  test('Authorization logging', async () => {
    const secrets = ['SECRET-A', 'SECRET-B', 'SECRET-C'];
    const path = '/v1/private-path-segment';
    const target = `https://${HOST}${path}?api_key=SECRET-C`;
    const headers = { authorization: 'Bearer SECRET-A', 'x-api-key': 'SECRET-B' };
    const bodies: string[] = [];

    const ok = harness();
    const success = await ok.send(fetchRequest({ target, session: await session(), headers }));
    expect(success.status).toBe(200);
    await success.text();
    await ok.settle();
    // The credentials do reach the upstream: they are the visitor's own key.
    expect(new Headers(ok.calls[0]?.init?.headers).get('authorization')).toBe('Bearer SECRET-A');
    expect(ok.calls[0]?.url).toBe(target);

    const bad = harness({ resolve: () => Promise.resolve({ ok: false }) });
    const failure = await bad.send(fetchRequest({ target, session: await session(), headers }));
    expect(failure.status).toBe(502);
    bodies.push(await failure.text());
    const noSession = await bad.send(fetchRequest({ target, headers }));
    expect(noSession.status).toBe(401);
    bodies.push(await noSession.text());
    await bad.settle();

    const logs = [...ok.logs, ...bad.logs];
    expect(logs).toHaveLength(3);
    expect(logs.every((entry) => entry.host === undefined || entry.host === HOST)).toBe(true);
    const written = [...logs.map((entry) => JSON.stringify(entry)), ...bodies].join('\n');
    for (const secret of secrets) expect(written).not.toContain(secret);
    expect(written).not.toContain(path);
    expect(written).not.toContain('api_key');
  });

  test('host not in sources.json', async () => {
    expect(RELAY_HOSTS.has('evil.test')).toBe(false);
    const explode = (): never => {
      throw new Error('must not be reached');
    };
    const throwing: Limiter = { limit: explode };
    const deps: RelayDeps = {
      hosts: RELAY_HOSTS,
      origin: SITE,
      sessionSecret: SECRET,
      fetch: explode,
      resolve: explode,
      verifyTurnstile: explode,
      limiter: throwing,
      sessionLimiter: throwing,
      now: () => NOW,
      log: () => undefined,
    };
    const handle = createHandler(deps);
    const ctx = { waitUntil: () => undefined };
    const request = (): Request =>
      fetchRequest({ target: 'https://evil.test/', session: 'v1.1.abc' });

    const first = await handle(request(), ctx);
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({ error: 'host_not_allowed' });

    for (let i = 0; i < 20; i++) await handle(request(), ctx);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const req = request();
      const start = performance.now();
      const response = await handle(req, ctx);
      times.push(performance.now() - start);
      expect(response.status).toBe(403);
    }
    times.sort((a, b) => a - b);
    const median = ((times[99] ?? 0) + (times[100] ?? 0)) / 2;
    expect(median).toBeLessThan(5);
  });
});
