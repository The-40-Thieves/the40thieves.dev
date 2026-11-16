import { forward, type ForwardError } from './forward.ts';
import { clientHeaders } from './headers.ts';
import type { LogEntry } from './log.ts';
import type { Resolver } from './resolve.ts';
import { secondsToReset, utcDay, visitorKey, type QuotaSource, type QuotaStore } from './quota.ts';
import { mintSession, verifySession } from './session.ts';
import { parseTarget } from './target.ts';
import type { TurnstileVerifier } from './turnstile.ts';

export type { LogEntry } from './log.ts';

/**
 * Every error the relay answers, with its status. Error bodies are `{ "error": "<code>" }`.
 * Kept a plain literal, one entry per line: the OpenAPI test reads this file as text.
 */
export const ERROR_CODES = {
  origin_not_allowed: 403,
  method_not_allowed: 405,
  bad_target: 400,
  host_not_allowed: 403,
  session_required: 401,
  session_invalid: 401,
  rate_limited: 429,
  quota_reached: 429,
  body_too_large: 413,
  dns_blocked: 502,
  upstream_redirect: 502,
  upstream_too_large: 502,
  upstream_timeout: 504,
  upstream_failed: 502,
  turnstile_failed: 403,
  not_found: 404,
  not_configured: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Largest request body passed upstream. */
export const REQUEST_CAP_BYTES = 64 * 1024;
/** Largest `/v1/session` body. */
const SESSION_BODY_CAP_BYTES = 4096;
/** Mirrors `ratelimits[].simple.period` in wrangler.jsonc (60 fetches, 5 sessions per IP). */
const RATE_LIMIT_PERIOD_SECONDS = 60;

const FETCH_METHODS = new Set(['GET', 'HEAD', 'POST']);
const EXPOSED_HEADERS = 'content-type, etag, last-modified, retry-after, x-quota-remaining';
const QUOTA_PREFIX = '/v1/quota/';
const JSON_TYPE = 'application/json; charset=utf-8';

/** The Rate Limiting binding's shape (copied from workers/mcp/src/ratelimit.ts). */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The client IP Cloudflare attaches, or one shared "unknown" budget when it is absent. */
export function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** True when this request is over the budget for its key. */
export async function overLimit(limiter: Limiter, request: Request): Promise<boolean> {
  const { success } = await limiter.limit({ key: clientKey(request) });
  return !success;
}

export interface RelayDeps {
  /** Upstream hostnames the relay may reach. */
  hosts: ReadonlySet<string>;
  /** The one browser origin allowed to call `/v1/session` and `/v1/fetch`. */
  origin: string;
  sessionSecret: string;
  fetch: typeof fetch;
  resolve: Resolver;
  verifyTurnstile: TurnstileVerifier;
  /** `/v1/fetch`, 60 per IP per minute. */
  limiter: Limiter;
  /** `/v1/session`, 5 per IP per minute. */
  sessionLimiter: Limiter;
  now: () => number;
  log: (entry: LogEntry) => void;
  /** The quota relay (P4-S3); without it every `/v1/quota/*` request is not_configured. */
  quota?: QuotaDeps | undefined;
}

/** One cost-dashboard data point per `/v1/quota/*` request (Workers Analytics Engine). */
export interface QuotaMetric {
  source: string;
  outcome: string;
  status: number;
}

export interface QuotaDeps {
  sources: ReadonlyMap<string, QuotaSource>;
  /** Operator keys by source; a source without one answers not_configured. */
  keys: ReadonlyMap<string, string>;
  store: QuotaStore;
  metric: (point: QuotaMetric) => void;
}

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** The headers every relay response carries: the `relay` policy headers and `cache-control: no-store`. */
function baseHeaders(): Headers {
  return clientHeaders(new Headers());
}

function json(status: number, body: unknown, headers = baseHeaders()): Response {
  headers.set('content-type', JSON_TYPE);
  return new Response(JSON.stringify(body), { status, headers });
}

/** `{ "error": code }` with its status, the policy headers and any extra headers. */
export function errorResponse(code: ErrorCode, extra: Record<string, string> = {}): Response {
  const headers = baseHeaders();
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return json(ERROR_CODES[code], { error: code }, headers);
}

/**
 * `GET /v1/healthz`: up, how many hosts are allowed, whether both secrets are set, and which
 * quota sources have an operator key (names only).
 */
export function healthzResponse(
  hosts: number,
  configured: boolean,
  quota: readonly string[] = [],
): Response {
  return json(200, { ok: true, hosts, configured, quota });
}

/** The read side of CORS, on every response to the allowed origin, errors included. */
function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-expose-headers', EXPOSED_HEADERS);
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

function preflight(request: Request, origin: string, methods: string): Response {
  const headers = baseHeaders();
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', methods);
  const asked = request.headers.get('access-control-request-headers');
  if (asked !== null) headers.set('access-control-allow-headers', asked);
  headers.set('access-control-max-age', '600');
  headers.set('vary', 'Origin');
  return new Response(null, { status: 204, headers });
}

/**
 * The request body, read into memory up to `cap` bytes; `null` when it is larger (declared or
 * actual), and the stream is cancelled. An empty body is `Uint8Array(0)`.
 */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > cap) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The relay's request handler. `/v1/fetch` checks, first failure answering: preflight, origin,
 * method, target and allowlist (before any await), session, rate limit, request body cap, DNS,
 * then forwards. Each session, fetch and unknown-path request writes one log entry (preflights
 * and healthz write none); a refusal logs at once, a relayed body's entry is written through
 * `ctx.waitUntil` once the body finishes, with the real byte count and outcome.
 */
export function createHandler(
  deps: RelayDeps,
): (request: Request, ctx: WaitUntil) => Promise<Response> {
  async function relay(
    request: Request,
    ctx: WaitUntil,
    started: number,
    corsMatched: boolean,
  ): Promise<Response> {
    const refuse = (code: ErrorCode, host?: string, extra?: Record<string, string>): Response => {
      deps.log({
        route: 'fetch',
        outcome: code,
        status: ERROR_CODES[code],
        ...(host === undefined ? {} : { host }),
        ms: deps.now() - started,
      });
      return errorResponse(code, extra);
    };

    if (!corsMatched) return refuse('origin_not_allowed');
    if (!FETCH_METHODS.has(request.method)) {
      return refuse('method_not_allowed', undefined, { allow: 'GET, HEAD, POST' });
    }
    // Synchronous: a host off the allowlist is refused before anything is awaited.
    const target = parseTarget(request.headers.get('x-relay-target'), deps.hosts);
    if (!target.ok) return refuse(target.error);
    const host = target.url.hostname;

    const verdict = await verifySession(
      deps.sessionSecret,
      request.headers.get('x-relay-session'),
      deps.now(),
    );
    if (verdict === 'missing') return refuse('session_required', host);
    if (verdict === 'invalid') return refuse('session_invalid', host);

    if (await overLimit(deps.limiter, request)) {
      return refuse('rate_limited', host, { 'retry-after': String(RATE_LIMIT_PERIOD_SECONDS) });
    }

    let body: ReadableStream<Uint8Array> | null = null;
    if (request.method === 'POST') {
      const bytes = await readCapped(request, REQUEST_CAP_BYTES);
      if (bytes === null) return refuse('body_too_large', host);
      if (bytes.byteLength > 0) body = bodyStream(bytes);
    }

    const dns = await deps.resolve(host);
    if (!dns.ok) return refuse('dns_blocked', host);

    const result = await forward(
      { url: target.url, method: request.method, headers: request.headers, body },
      { fetch: deps.fetch, now: deps.now },
    );
    if (!result.ok) return refuse(result.error satisfies ForwardError, host);

    const { status } = result.response;
    ctx.waitUntil(
      result.done.then(({ bytes, outcome }) => {
        deps.log({ route: 'fetch', outcome, status, host, bytes, ms: deps.now() - started });
      }),
    );
    return result.response;
  }

  /**
   * `/v1/quota/<source>`: like `/v1/fetch`, but to one source's host only, GET or HEAD, with the
   * visitor's credentials removed and the operator key added, after one request of the day's
   * site and visitor budgets is reserved. Checks, first failure answering: origin, method,
   * source, target, operator key, session, rate limit, DNS, budget.
   */
  async function quota(
    request: Request,
    ctx: WaitUntil,
    started: number,
    corsMatched: boolean,
    name: string,
  ): Promise<Response> {
    const known = deps.quota?.sources.get(name);
    // Data points are billable, so only requests past the session and rate-limit checks write
    // one; anything refused earlier costs at most a log line.
    let counted = false;
    const metric = (outcome: string, status: number): void => {
      if (counted && known !== undefined) {
        deps.quota?.metric({ source: known.name, outcome, status });
      }
    };
    const refuse = (code: ErrorCode, host?: string, extra?: Record<string, string>): Response => {
      deps.log({
        route: 'quota',
        outcome: code,
        status: ERROR_CODES[code],
        ...(host === undefined ? {} : { host }),
        ms: deps.now() - started,
      });
      metric(code, ERROR_CODES[code]);
      return errorResponse(code, extra);
    };

    if (!corsMatched) return refuse('origin_not_allowed');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refuse('method_not_allowed', undefined, { allow: 'GET, HEAD' });
    }
    if (deps.quota === undefined) return refuse('not_configured');
    if (known === undefined) return refuse('not_found');
    const target = parseTarget(request.headers.get('x-relay-target'), new Set([known.host]));
    if (!target.ok) return refuse(target.error);
    const host = known.host;
    const operatorKey = deps.quota.keys.get(known.name);
    if (operatorKey === undefined) return refuse('not_configured', host);

    const verdict = await verifySession(
      deps.sessionSecret,
      request.headers.get('x-relay-session'),
      deps.now(),
    );
    if (verdict === 'missing') return refuse('session_required', host);
    if (verdict === 'invalid') return refuse('session_invalid', host);
    if (await overLimit(deps.limiter, request)) {
      return refuse('rate_limited', host, { 'retry-after': String(RATE_LIMIT_PERIOD_SECONDS) });
    }
    counted = true;
    const dns = await deps.resolve(host);
    if (!dns.ok) return refuse('dns_blocked', host);

    const now = deps.now();
    const day = utcDay(now);
    const budget = await deps.quota.store(known.name, {
      day,
      visitor: await visitorKey(deps.sessionSecret, day, clientKey(request)),
      siteCap: known.siteCap,
      visitorCap: known.visitorCap,
    });
    if (!budget.ok) {
      return refuse('quota_reached', host, { 'retry-after': String(secondsToReset(now)) });
    }

    // The visitor's own credentials never travel with the operator key.
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    // upstreamHeaders drops every header the request's Connection header names, so a visitor
    // could name the key header there and send the request without the operator key while still
    // spending the budget. Connection is hop-by-hop anyway.
    headers.delete('connection');
    const url = new URL(target.url);
    if (known.key.in === 'header') {
      headers.set(known.key.name, `${known.key.prefix}${operatorKey}`);
    } else {
      url.searchParams.set(known.key.name, operatorKey);
    }
    const result = await forward(
      { url, method: request.method, headers, body: null },
      { fetch: deps.fetch, now: deps.now },
    );
    if (!result.ok) return refuse(result.error satisfies ForwardError, host);

    const { status } = result.response;
    result.response.headers.set('x-quota-remaining', String(budget.remaining));
    ctx.waitUntil(
      result.done.then(({ bytes, outcome }) => {
        deps.log({ route: 'quota', outcome, status, host, bytes, ms: deps.now() - started });
        metric(outcome, status);
      }),
    );
    return result.response;
  }

  async function session(request: Request, started: number, corsMatched: boolean) {
    const refuse = (code: ErrorCode, extra?: Record<string, string>): Response => {
      deps.log({
        route: 'session',
        outcome: code,
        status: ERROR_CODES[code],
        ms: deps.now() - started,
      });
      return errorResponse(code, extra);
    };

    if (!corsMatched) return refuse('origin_not_allowed');
    if (request.method !== 'POST') return refuse('method_not_allowed', { allow: 'POST' });
    if (await overLimit(deps.sessionLimiter, request)) {
      return refuse('rate_limited', { 'retry-after': String(RATE_LIMIT_PERIOD_SECONDS) });
    }
    const bytes = await readCapped(request, SESSION_BODY_CAP_BYTES);
    if (bytes === null) return refuse('body_too_large');
    // A body that is not `{ "token": string }` cannot pass the check, so it fails as one.
    let token: unknown;
    try {
      token = (JSON.parse(new TextDecoder().decode(bytes)) as { token?: unknown } | null)?.token;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string') return refuse('turnstile_failed');
    if (!(await deps.verifyTurnstile(token, request.headers.get('cf-connecting-ip')))) {
      return refuse('turnstile_failed');
    }
    const minted = await mintSession(deps.sessionSecret, deps.now());
    deps.log({ route: 'session', outcome: 'minted', status: 200, ms: deps.now() - started });
    return json(200, minted);
  }

  return async (request, ctx) => {
    const started = deps.now();
    const { pathname } = new URL(request.url);
    const corsMatched = request.headers.get('origin') === deps.origin;

    let response: Response;
    if (pathname === '/v1/fetch' || pathname === '/v1/session') {
      const isFetch = pathname === '/v1/fetch';
      if (request.method === 'OPTIONS' && corsMatched) {
        return preflight(request, deps.origin, isFetch ? 'GET, HEAD, POST' : 'POST');
      }
      response = isFetch
        ? await relay(request, ctx, started, corsMatched)
        : await session(request, started, corsMatched);
    } else if (pathname.startsWith(QUOTA_PREFIX)) {
      if (request.method === 'OPTIONS' && corsMatched) {
        return preflight(request, deps.origin, 'GET, HEAD');
      }
      response = await quota(
        request,
        ctx,
        started,
        corsMatched,
        pathname.slice(QUOTA_PREFIX.length),
      );
    } else if (pathname === '/v1/healthz') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const quotaNames = [...(deps.quota?.keys.keys() ?? [])].sort();
        response = healthzResponse(deps.hosts.size, true, quotaNames);
      } else {
        response = errorResponse('method_not_allowed', { allow: 'GET, HEAD' });
      }
    } else {
      deps.log({ route: 'other', outcome: 'not_found', status: 404, ms: deps.now() - started });
      response = errorResponse('not_found');
    }
    return corsMatched ? withCors(response, deps.origin) : response;
  };
}
