import type { Limiter, LogEntry, RelayDeps } from '../src/handler.ts';
import type { Resolver } from '../src/resolve.ts';
import { createTurnstileVerifier } from '../src/turnstile.ts';

/**
 * The relay's local-stack dependencies (P4-S2), for stack-entry.ts, which is never deployed.
 * They run the production handler with nothing that can leave this machine: the one allowed
 * host is `upstream.test`, served by the mock upstream `scripts/relay-stack.ts` starts on loopback,
 * and nothing else is fetched, resolved or verified over the network. Every secret here is a test
 * value published in this file.
 */

/** The only upstream host the stack allows. `.test` is reserved (RFC 6761) and never resolves. */
export const STACK_HOST = 'upstream.test';
/** Signs stack sessions. A literal by design: a stack session is worth nothing anywhere else. */
export const STACK_SESSION_SECRET = 'stack-only-not-a-secret';
/** Cloudflare's published always-pass Turnstile test secret. */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
/** The response token Cloudflare's Turnstile test sitekeys produce. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** The hostname siteverify reports for the test keys. */
const TURNSTILE_TEST_HOSTNAME = 'example.com';

export interface StackEnv {
  /** The stack's own origin, the one browser origin it allows. */
  SITE: string;
  /** The mock upstream's origin, `http://127.0.0.1:<port>`. */
  UPSTREAM: string;
}

/** `value` as a URL whose origin is `http://127.0.0.1:<port>`, or a thrown error naming `name`. */
function loopbackOrigin(name: string, value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== value) {
    throw new Error(`relay stack: ${name} must be http://127.0.0.1:<port>`);
  }
  return url;
}

/** Rewrites `https://upstream.test/<path>` onto the mock upstream; refuses every other URL. */
function mockUpstreamFetch(upstream: URL): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || url.hostname !== STACK_HOST || url.port !== '') {
      return Promise.reject(new TypeError(`relay stack: only https://${STACK_HOST} is reachable`));
    }
    return fetch(new URL(`${url.pathname}${url.search}`, upstream), init);
  };
}

/** Answers siteverify the way Cloudflare does for the always-pass test secret and dummy token. */
const siteverify: typeof fetch = (_input, init) => {
  const form = new URLSearchParams(init?.body as URLSearchParams | undefined);
  const success =
    form.get('secret') === TURNSTILE_TEST_SECRET && form.get('response') === TURNSTILE_DUMMY_TOKEN;
  const answer = success
    ? { success, hostname: TURNSTILE_TEST_HOSTNAME }
    : { success, 'error-codes': ['invalid-input-response'] };
  return Promise.resolve(Response.json(answer));
};

/** Only the mock host resolves; it is local, so the real resolver would refuse it as private. */
const resolve: Resolver = (host) =>
  Promise.resolve(host === STACK_HOST ? { ok: true } : { ok: false });

/** No budget: a scanner sends far more than 60 requests a minute and must reach the handler. */
const unlimited: Limiter = { limit: () => Promise.resolve({ success: true }) };

export function stackDeps(env: StackEnv, log: (entry: LogEntry) => void): RelayDeps {
  const upstream = loopbackOrigin('UPSTREAM', env.UPSTREAM);
  const site = loopbackOrigin('SITE', env.SITE);
  return {
    hosts: new Set([STACK_HOST]),
    origin: site.origin,
    sessionSecret: STACK_SESSION_SECRET,
    fetch: mockUpstreamFetch(upstream),
    resolve,
    verifyTurnstile: createTurnstileVerifier({
      fetch: siteverify,
      secret: TURNSTILE_TEST_SECRET,
      hostnames: new Set([TURNSTILE_TEST_HOSTNAME]),
    }),
    limiter: unlimited,
    sessionLimiter: unlimited,
    now: Date.now,
    log,
  };
}
