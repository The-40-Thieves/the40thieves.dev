import { afterEach, expect, test, vi } from 'vitest';

import { forward } from '../src/forward.ts';

const CAP = 2 * 1024 * 1024;
const URL_ = new URL('https://api.example.com/v1/models?key=secret');

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch that records each call and answers with `answer()`. */
function fakeFetch(answer: (init: RequestInit | undefined) => Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    return answer(init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** An upstream body that tracks how often it was pulled and whether it was cancelled. */
function trackedBody(chunks: Uint8Array[]) {
  const state = { pulls: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** `total` bytes in 64 KiB chunks. */
function bytes(total: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let left = total; left > 0; left -= 65_536)
    chunks.push(new Uint8Array(Math.min(left, 65_536)));
  return chunks;
}

/** Read `stream` to the end, counting bytes; resolves with the count or the rejection reason. */
async function drain(
  stream: ReadableStream<Uint8Array> | null,
): Promise<{ bytes: number; error: unknown }> {
  let count = 0;
  if (stream === null) return { bytes: 0, error: undefined };
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: count, error: undefined };
      count += value.byteLength;
    }
  } catch (error) {
    return { bytes: count, error };
  }
}

const input = (headers: HeadersInit = {}, body: ReadableStream | null = null, method = 'GET') => ({
  url: URL_,
  method,
  headers: new Headers(headers),
  body,
});

const deps = (fetchFn: typeof fetch) => ({ fetch: fetchFn, now: () => Date.now() });

afterEach(() => {
  vi.useRealTimers();
});

test('the upstream call refuses redirects and carries only the filtered headers', async () => {
  const { fetchFn, calls } = fakeFetch(() => Promise.resolve(new Response('ok')));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    },
  });
  const result = await forward(
    input(
      { authorization: 'Bearer k', cookie: 'a=1', 'x-relay-session': 's', 'content-length': '2' },
      body,
      'POST',
    ),
    deps(fetchFn),
  );
  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call?.url).toBe(URL_.href);
  expect(call?.init?.method).toBe('POST');
  expect(call?.init?.redirect).toBe('manual');
  expect(call?.init?.body).toBe(body);
  expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  const sent = new Headers(call?.init?.headers);
  expect(sent.get('authorization')).toBe('Bearer k');
  expect(sent.has('cookie')).toBe(false);
  expect(sent.has('x-relay-session')).toBe(false);
  expect(sent.has('content-length')).toBe(false);
  expect(sent.get('user-agent')).toBe(
    'the40thieves-relay/1 (+https://the40thieves.dev/alexandria/sources/)',
  );
  if (result.ok) await drain(result.response.body);
});

for (const method of ['GET', 'HEAD', 'POST']) {
  test(`a ${method} upstream call bypasses the Cloudflare cache with cache: no-store`, async () => {
    const { fetchFn, calls } = fakeFetch(() => Promise.resolve(new Response('ok')));
    const result = await forward(input({}, null, method), deps(fetchFn));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.cache).toBe('no-store');
    if (result.ok) await drain(result.response.body);
  });
}

test('an upstream status outside 200 to 599 is upstream_failed and leaves no armed timer', async () => {
  vi.useFakeTimers();
  // `new Response` refuses a 101, so the fake upstream is a plain object of the same shape.
  const switching = { status: 101, headers: new Headers(), body: null } as unknown as Response;
  const { fetchFn } = fakeFetch(() => Promise.resolve(switching));
  expect(await forward(input(), deps(fetchFn))).toEqual({ ok: false, error: 'upstream_failed' });
  expect(vi.getTimerCount()).toBe(0);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${String(status)} is refused as upstream_redirect and its body cancelled`, async () => {
    const { stream, state } = trackedBody(bytes(10));
    const { fetchFn } = fakeFetch(() =>
      Promise.resolve(
        new Response(stream, { status, headers: { location: 'http://169.254.169.254/' } }),
      ),
    );
    expect(await forward(input(), deps(fetchFn))).toEqual({
      ok: false,
      error: 'upstream_redirect',
    });
    expect(state.cancelled).toBe(true);
  });
}

test('a declared content-length past the cap is refused before any body byte is read', async () => {
  const { stream, state } = trackedBody(bytes(CAP + 1));
  const { fetchFn } = fakeFetch(() =>
    Promise.resolve(new Response(stream, { headers: { 'content-length': String(CAP + 1) } })),
  );
  expect(await forward(input(), deps(fetchFn))).toEqual({
    ok: false,
    error: 'upstream_too_large',
  });
  expect(state.pulls).toBe(0);
  expect(state.cancelled).toBe(true);
});

test('a body of exactly the cap without content-length arrives whole', async () => {
  const { stream } = trackedBody(bytes(CAP));
  const { fetchFn } = fakeFetch(() => Promise.resolve(new Response(stream)));
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  expect(await drain(result.response.body)).toEqual({ bytes: CAP, error: undefined });
  expect(await result.done).toEqual({ bytes: CAP, outcome: 'complete' });
});

test('a body one byte past the cap errors the stream and stops short of the cap', async () => {
  const { stream, state } = trackedBody(bytes(CAP + 1));
  const { fetchFn } = fakeFetch(() => Promise.resolve(new Response(stream)));
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  const read = await drain(result.response.body);
  expect(read.error).toBeInstanceOf(Error);
  expect(String(read.error)).not.toContain('example.com');
  expect(read.bytes).toBeLessThan(CAP + 1);
  const done = await result.done;
  expect(done.outcome).toBe('too_large');
  expect(done.bytes).toBe(read.bytes);
  expect(state.cancelled).toBe(true);
});

test('a fetch that never answers gives upstream_timeout at 20 000 ms', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const { fetchFn } = fakeFetch((init) => {
    signal = init?.signal;
    return new Promise<Response>(() => undefined);
  });
  let settled: unknown;
  void forward(input(), deps(fetchFn)).then((value) => (settled = value));
  await vi.advanceTimersByTimeAsync(19_999);
  expect(settled).toBeUndefined();
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toEqual({ ok: false, error: 'upstream_timeout' });
  expect(signal?.aborted).toBe(true);
});

test('headers at 1 s and a stalled body: the stream errors at 20 000 ms in total', async () => {
  vi.useFakeTimers();
  const stalled = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
    },
    { highWaterMark: 0 },
  );
  const { fetchFn } = fakeFetch(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(new Response(stalled));
        }, 1_000);
      }),
  );
  const pending = forward(input(), deps(fetchFn));
  await vi.advanceTimersByTimeAsync(1_000);
  const result = await pending;
  if (!result.ok) throw new Error(result.error);
  let read: { bytes: number; error: unknown } | undefined;
  void drain(result.response.body).then((value) => (read = value));
  await vi.advanceTimersByTimeAsync(18_999);
  expect(read).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(read?.bytes).toBe(100);
  expect(read?.error).toBeInstanceOf(Error);
  expect(await result.done).toEqual({ bytes: 100, outcome: 'timeout' });
});

test('a fetch that throws gives upstream_failed', async () => {
  const { fetchFn } = fakeFetch(() => Promise.reject(new TypeError('network down')));
  expect(await forward(input(), deps(fetchFn))).toEqual({ ok: false, error: 'upstream_failed' });
});

for (const status of [404, 500]) {
  test(`a ${String(status)} from upstream passes through with its status`, async () => {
    const { fetchFn } = fakeFetch(() =>
      Promise.resolve(
        new Response('{"error":"nope"}', {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await forward(input(), deps(fetchFn));
    if (!result.ok) throw new Error(result.error);
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get('content-type')).toBe('application/json');
    expect(await result.response.text()).toBe('{"error":"nope"}');
    expect(await result.done).toEqual({ bytes: 16, outcome: 'complete' });
  });
}

test('the response carries client headers only, never content-length or content-encoding', async () => {
  const { fetchFn } = fakeFetch(() =>
    Promise.resolve(
      new Response('abc', {
        headers: {
          'content-length': '3',
          'content-encoding': 'identity',
          'set-cookie': 'a=1',
          etag: '"e"',
        },
      }),
    ),
  );
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  expect(result.response.headers.has('content-length')).toBe(false);
  expect(result.response.headers.has('content-encoding')).toBe(false);
  expect(result.response.headers.has('set-cookie')).toBe(false);
  expect(result.response.headers.get('etag')).toBe('"e"');
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  await drain(result.response.body);
});

test('a response with no body settles done as complete with zero bytes', async () => {
  const { fetchFn } = fakeFetch(() => Promise.resolve(new Response(null, { status: 204 })));
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  expect(result.response.status).toBe(204);
  expect(result.response.body).toBeNull();
  expect(await result.done).toEqual({ bytes: 0, outcome: 'complete' });
});

test('a client that cancels the stream aborts the upstream and settles done as failed', async () => {
  const { stream, state } = trackedBody(bytes(CAP));
  let signal: AbortSignal | null | undefined;
  const { fetchFn } = fakeFetch((init) => {
    signal = init?.signal;
    return Promise.resolve(new Response(stream));
  });
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  await reader.cancel();
  expect(await result.done).toEqual({ bytes: first.value?.byteLength, outcome: 'failed' });
  expect(signal?.aborted).toBe(true);
  expect(state.cancelled).toBe(true);
});

test('an upstream body that errors settles done as failed and errors the stream', async () => {
  let pulls = 0;
  const broken = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(10));
        else controller.error(new Error('reset'));
      },
    },
    { highWaterMark: 0 },
  );
  const { fetchFn } = fakeFetch(() => Promise.resolve(new Response(broken)));
  const result = await forward(input(), deps(fetchFn));
  if (!result.ok) throw new Error(result.error);
  const read = await drain(result.response.body);
  expect(read.bytes).toBe(10);
  expect(read.error).toBeInstanceOf(Error);
  expect(await result.done).toEqual({ bytes: 10, outcome: 'failed' });
});
