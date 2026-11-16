import { clientHeaders, upstreamHeaders } from './headers.ts';

/** Largest upstream response body the relay passes on. */
export const RESPONSE_CAP_BYTES = 2 * 1024 * 1024;
/** One budget from the moment the upstream fetch starts to the last body byte delivered. */
export const DEADLINE_MS = 20_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses whose Response must have a null body (a 101 is refused before this is consulted). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface ForwardInput {
  url: URL;
  method: string;
  headers: Headers;
  body: ReadableStream | null;
}

export interface ForwardDeps {
  fetch: typeof fetch;
  now: () => number;
}

export type ForwardOutcome = 'complete' | 'too_large' | 'timeout' | 'failed';

export type ForwardError =
  'upstream_redirect' | 'upstream_too_large' | 'upstream_timeout' | 'upstream_failed';

export type ForwardResult =
  | {
      ok: true;
      response: Response;
      /** Settles when the body finishes, errors or is cancelled by the client; never rejects. */
      done: Promise<{ bytes: number; outcome: ForwardOutcome }>;
    }
  | { ok: false; error: ForwardError };

/** Rejects once `signal` aborts; never resolves. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function cancelQuietly(body: ReadableStream | null): void {
  body?.cancel().catch(() => undefined);
}

/**
 * Relay one request upstream and stream the answer back. Redirects are refused, the body is
 * capped at `RESPONSE_CAP_BYTES` and the whole exchange at `DEADLINE_MS`; the response body is
 * never buffered. Errors carry a code only: no URL, query string or header value.
 */
export async function forward(input: ForwardInput, deps: ForwardDeps): Promise<ForwardResult> {
  const controller = new AbortController();
  const { signal } = controller;
  const started = deps.now();
  const timer = setTimeout(() => {
    controller.abort();
  }, DEADLINE_MS);

  // `duplex` is required by fetch implementations that follow the spec when the body is a
  // stream; the Workers types do not declare it.
  const init: RequestInit & { duplex?: 'half' } = {
    method: input.method,
    headers: upstreamHeaders(input.headers),
    body: input.body,
    redirect: 'manual',
    // Bypass Cloudflare's cache: a cached answer is keyed on the URL alone, so it could be
    // replayed to another visitor whose key travelled in a header.
    cache: 'no-store',
    signal,
  };
  if (input.body !== null) init.duplex = 'half';

  let upstream: Response;
  try {
    upstream = await Promise.race([deps.fetch(input.url.href, init), aborted(signal)]);
  } catch {
    clearTimeout(timer);
    const timedOut = signal.aborted;
    controller.abort();
    return { ok: false, error: timedOut ? 'upstream_timeout' : 'upstream_failed' };
  }

  const refuse = (error: ForwardError): ForwardResult => {
    clearTimeout(timer);
    cancelQuietly(upstream.body);
    controller.abort();
    return { ok: false, error };
  };

  // `new Response` throws outside 200 to 599 (a 101, say), so such an answer is a failure.
  if (upstream.status < 200 || upstream.status > 599) return refuse('upstream_failed');
  if (REDIRECT_STATUSES.has(upstream.status)) return refuse('upstream_redirect');
  const declared = upstream.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > RESPONSE_CAP_BYTES) {
    return refuse('upstream_too_large');
  }

  const headers = clientHeaders(upstream.headers);
  const source = upstream.body;
  if (source === null || NULL_BODY_STATUSES.has(upstream.status)) {
    clearTimeout(timer);
    cancelQuietly(source);
    return {
      ok: true,
      response: new Response(null, { status: upstream.status, headers }),
      done: Promise.resolve({ bytes: 0, outcome: 'complete' }),
    };
  }

  const reader = source.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let bytes = 0;
  let settled = false;
  let settle!: (value: { bytes: number; outcome: ForwardOutcome }) => void;
  const done = new Promise<{ bytes: number; outcome: ForwardOutcome }>((resolve) => {
    settle = resolve;
  });

  /** Settle `done` once, stop the clock and release the upstream. */
  const finish = (outcome: ForwardOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle({ bytes, outcome });
    if (outcome !== 'complete') {
      controller.abort();
      reader.cancel().catch(() => undefined);
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(out) {
        signal.addEventListener(
          'abort',
          () => {
            if (settled) return;
            out.error(new Error('upstream_timeout'));
            finish('timeout');
          },
          { once: true },
        );
      },
      async pull(out) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (settled) return;
          out.error(new Error('upstream_failed'));
          finish('failed');
          return;
        }
        if (settled) return;
        if (deps.now() - started >= DEADLINE_MS) {
          out.error(new Error('upstream_timeout'));
          finish('timeout');
          return;
        }
        if (chunk.done) {
          out.close();
          finish('complete');
          return;
        }
        if (bytes + chunk.value.byteLength > RESPONSE_CAP_BYTES) {
          out.error(new Error('upstream_too_large'));
          finish('too_large');
          return;
        }
        bytes += chunk.value.byteLength;
        out.enqueue(chunk.value);
      },
      cancel() {
        finish('failed');
      },
    },
    { highWaterMark: 0 },
  );

  return {
    ok: true,
    response: new Response(body, { status: upstream.status, headers }),
    done,
  };
}
