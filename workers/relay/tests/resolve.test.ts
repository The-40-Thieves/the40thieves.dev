import { expect, test } from 'vitest';

import { createDohResolver } from '../src/resolve.ts';

interface Rec {
  type: number;
  data: string;
}

function body(records: Rec[] | undefined, status = 0): string {
  return JSON.stringify({
    Status: status,
    ...(records ? { Answer: records.map((r) => ({ name: 'x.example.com.', TTL: 60, ...r })) } : {}),
  });
}

/** A fake DoH endpoint: answers by the `type` query parameter and records every call. */
function fakeDoh(answers: { A?: string; AAAA?: string; status?: number } | 'throw') {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, init });
    if (answers === 'throw') return Promise.reject(new Error('network down'));
    const type = url.searchParams.get('type') as 'A' | 'AAAA';
    return Promise.resolve(
      new Response(answers[type] ?? body(undefined), { status: answers.status ?? 200 }),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const publicA = body([{ type: 1, data: '93.184.216.34' }]);
const publicAAAA = body([{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]);

test('all public A and AAAA answers are ok', async () => {
  const { fetchFn, calls } = fakeDoh({ A: publicA, AAAA: publicAAAA });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('api.example.com')).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  const first = calls[0]?.url;
  expect(first && first.origin + first.pathname).toBe('https://cloudflare-dns.com/dns-query');
  expect(calls.map((c) => c.url.searchParams.get('type')).sort()).toEqual(['A', 'AAAA']);
  expect(calls.every((c) => c.url.searchParams.get('name') === 'api.example.com')).toBe(true);
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get('accept')).toBe('application/dns-json');
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  }
});

test('a host with A records and an empty AAAA answer is ok', async () => {
  const { fetchFn } = fakeDoh({ A: publicA });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('v4only.example.com')).toEqual({ ok: true });
});

test('an IPv6-only host is ok', async () => {
  const { fetchFn } = fakeDoh({ AAAA: publicAAAA });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('v6only.example.com')).toEqual({ ok: true });
});

test('a CNAME chain followed by public addresses is ok', async () => {
  const { fetchFn } = fakeDoh({
    A: body([
      { type: 5, data: 'edge.example.net.' },
      { type: 1, data: '93.184.216.34' },
    ]),
  });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('cname.example.com')).toEqual({ ok: true });
});

test('one private address among public ones is refused', async () => {
  const { fetchFn } = fakeDoh({
    A: body([
      { type: 1, data: '93.184.216.34' },
      { type: 1, data: '10.0.0.5' },
    ]),
    AAAA: publicAAAA,
  });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('mixed.example.com')).toEqual({ ok: false });
});

test('a private AAAA address is refused even when A is public', async () => {
  const { fetchFn } = fakeDoh({ A: publicA, AAAA: body([{ type: 28, data: '::ffff:10.0.0.1' }]) });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('v6private.example.com')).toEqual({ ok: false });
});

test('an address record whose data is not an address is refused', async () => {
  const { fetchFn } = fakeDoh({ A: body([{ type: 1, data: 'not-an-ip' }]) });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('junk.example.com')).toEqual({ ok: false });
});

test('an answer with only a CNAME and no address is refused', async () => {
  const cname = body([{ type: 5, data: 'elsewhere.example.net.' }]);
  const { fetchFn } = fakeDoh({ A: cname, AAAA: cname });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('dangling.example.com')).toEqual({ ok: false });
});

test('NXDOMAIN (Status 3) is refused', async () => {
  const { fetchFn } = fakeDoh({ A: body(undefined, 3), AAAA: body(undefined, 3) });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('nope.example.com')).toEqual({ ok: false });
});

test('a failing AAAA lookup refuses even when A is public', async () => {
  const { fetchFn } = fakeDoh({ A: publicA, AAAA: body(undefined, 2) });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('servfail6.example.com')).toEqual({ ok: false });
});

test('a thrown fetch is refused', async () => {
  const { fetchFn } = fakeDoh('throw');
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('down.example.com')).toEqual({ ok: false });
});

test('a non-200 is refused', async () => {
  const { fetchFn } = fakeDoh({ A: publicA, AAAA: publicAAAA, status: 503 });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('busy.example.com')).toEqual({ ok: false });
});

test('a 3xx is refused and never followed', async () => {
  const { fetchFn, calls } = fakeDoh({ A: publicA, AAAA: publicAAAA, status: 302 });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('moved.example.com')).toEqual({ ok: false });
  expect(calls).toHaveLength(2);
});

test('an unparsable body is refused', async () => {
  const { fetchFn } = fakeDoh({ A: '<html>oops</html>', AAAA: '{}' });
  const resolve = createDohResolver({ fetch: fetchFn, now: clock().now });
  expect(await resolve('garbage.example.com')).toEqual({ ok: false });
});

test('a verdict is cached for 300 s per host', async () => {
  const { fetchFn, calls } = fakeDoh({ A: publicA, AAAA: publicAAAA });
  const time = clock();
  const resolve = createDohResolver({ fetch: fetchFn, now: time.now });
  await resolve('cache.example.com');
  expect(calls).toHaveLength(2);
  time.advance(299_000);
  expect(await resolve('cache.example.com')).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  await resolve('other.example.com');
  expect(calls).toHaveLength(4);
  time.advance(1_000);
  expect(await resolve('cache.example.com')).toEqual({ ok: true });
  expect(calls).toHaveLength(6);
});

test('a failed lookup is cached for 30 s, not 300', async () => {
  const { fetchFn, calls } = fakeDoh('throw');
  const time = clock();
  const resolve = createDohResolver({ fetch: fetchFn, now: time.now });
  await resolve('flaky.example.com');
  expect(calls).toHaveLength(2);
  time.advance(29_000);
  await resolve('flaky.example.com');
  expect(calls).toHaveLength(2);
  time.advance(1_000);
  await resolve('flaky.example.com');
  expect(calls).toHaveLength(4);
});

test('the cache is per resolver, not global', async () => {
  const first = fakeDoh({ A: publicA });
  const second = fakeDoh({ A: publicA });
  const time = clock();
  await createDohResolver({ fetch: first.fetchFn, now: time.now })('same.example.com');
  await createDohResolver({ fetch: second.fetchFn, now: time.now })('same.example.com');
  expect(first.calls).toHaveLength(2);
  expect(second.calls).toHaveLength(2);
});
