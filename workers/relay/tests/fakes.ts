import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect } from 'vitest';

import { RELAY_HOSTS } from '../src/allowlist.ts';
import { createHandler, type Limiter, type LogEntry, type RelayDeps } from '../src/handler.ts';
import { mintSession } from '../src/session.ts';

export const SITE = 'https://the40thieves.dev';
export const SECRET = 'a-test-session-secret';
export const NOW = 1_800_000_000_000;
/** A real allowlisted host, so the gate tests run against the committed allowlist. */
export const HOST = [...RELAY_HOSTS][0] ?? 'missing.invalid';
export const BASE = 'https://relay.the40thieves.dev';

interface PolicyRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

const policy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../security/headers.policy.json'), 'utf8'),
) as { headers: PolicyRule[] };
const relayRules = policy.headers.filter(
  (rule) => rule.classes.includes('relay') && rule.path === undefined,
);

/** The six `relay` policy headers and `cache-control: no-store`, on any response. */
export function expectPolicyHeaders(response: Response): void {
  expect(relayRules).toHaveLength(6);
  for (const rule of relayRules) {
    expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
  }
  expect(response.headers.get('cache-control')).toBe('no-store');
}

/** Counts per key exactly, like the Rate Limiting binding with a fixed window. */
export class FakeRateLimiter implements Limiter {
  readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  limit(options: { key: string }): Promise<{ success: boolean }> {
    const count = (this.counts.get(options.key) ?? 0) + 1;
    this.counts.set(options.key, count);
    return Promise.resolve({ success: count <= this.max });
  }
}

export interface UpstreamCall {
  url: string;
  init: RequestInit | undefined;
}

type Answer = (init: RequestInit | undefined) => Promise<Response>;

const defaultAnswer: Answer = () =>
  Promise.resolve(
    new Response('{"models":[]}', { headers: { 'content-type': 'application/json' } }),
  );

/**
 * A handler over fakes. `answer` is the upstream; every `ctx.waitUntil` promise is kept so a
 * test can `settle()` before it reads the log.
 */
export function harness(options: { answer?: Answer } & Partial<RelayDeps> = {}) {
  const { answer = defaultAnswer, ...overrides } = options;
  const logs: LogEntry[] = [];
  const calls: UpstreamCall[] = [];
  const pending: Promise<unknown>[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return answer(init);
  }) as typeof fetch;
  const limiter = new FakeRateLimiter(60);
  const sessionLimiter = new FakeRateLimiter(5);
  const deps: RelayDeps = {
    hosts: RELAY_HOSTS,
    origin: SITE,
    sessionSecret: SECRET,
    fetch: fetchFn,
    resolve: () => Promise.resolve({ ok: true }),
    verifyTurnstile: (token) => Promise.resolve(token === 'good-token'),
    limiter,
    sessionLimiter,
    now: () => NOW,
    log: (entry) => {
      logs.push(entry);
    },
    ...overrides,
  };
  const handle = createHandler(deps);
  const ctx = {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
  };
  return {
    deps,
    logs,
    calls,
    limiter,
    sessionLimiter,
    send: (request: Request) => handle(request, ctx),
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

export function session(now = NOW): Promise<string> {
  return mintSession(SECRET, now).then((minted) => minted.session);
}

/** A `/v1/fetch` request from the site with the given target and session. */
export function fetchRequest(
  options: {
    target?: string | null;
    session?: string | null;
    origin?: string | null;
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
  } = {},
): Request {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' };
  const origin = options.origin === undefined ? SITE : options.origin;
  if (origin !== null) headers.origin = origin;
  const target = options.target === undefined ? `https://${HOST}/v1/models` : options.target;
  if (target !== null) headers['x-relay-target'] = target;
  if (options.session !== undefined && options.session !== null) {
    headers['x-relay-session'] = options.session;
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method: options.method ?? 'GET',
    headers: { ...headers, ...options.headers },
  };
  if (options.body !== undefined && options.body !== null) {
    init.body = options.body;
    if (options.body instanceof ReadableStream) init.duplex = 'half';
  }
  return new Request(`${BASE}/v1/fetch`, init);
}

/** A `POST /v1/session` from the site. */
export function sessionRequest(body: string, extra: Record<string, string> = {}): Request {
  return new Request(`${BASE}/v1/session`, {
    method: 'POST',
    headers: {
      origin: SITE,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
      ...extra,
    },
    body,
  });
}

/** Read `stream` to the end, counting bytes; resolves with the count or the rejection reason. */
export async function drain(
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

/** `total` bytes in 64 KiB chunks, pulled one at a time. */
export function chunkedBody(total: number): ReadableStream<Uint8Array> {
  let left = total;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (left <= 0) {
          controller.close();
          return;
        }
        const size = Math.min(left, 65_536);
        left -= size;
        controller.enqueue(new Uint8Array(size));
      },
    },
    { highWaterMark: 0 },
  );
}
