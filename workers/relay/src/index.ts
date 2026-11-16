import { RELAY_HOSTS } from './allowlist.ts';
import { createHandler, errorResponse, healthzResponse, type WaitUntil } from './handler.ts';
import { writeLog } from './log.ts';
import { parseOperatorKeys, QUOTA_SOURCES, type ReserveResult } from './quota.ts';
import { createDohResolver } from './resolve.ts';
import { createTurnstileVerifier } from './turnstile.ts';

/**
 * `relay` (P4-S2): the Worker on relay.the40thieves.dev. This file only turns bindings
 * into `RelayDeps`; every rule lives in handler.ts.
 */
interface Env {
  /** The one allowed browser origin. */
  SITE: string;
  /** Comma separated hostnames a Turnstile solve may report. */
  TURNSTILE_HOSTNAMES: string;
  RATE_LIMITER: RateLimit;
  SESSION_LIMITER: RateLimit;
  RELAY_SESSION_SECRET?: string | undefined;
  TURNSTILE_SECRET_KEY?: string | undefined;
  /** JSON object of quota-relay source name to operator key (P4-S3). */
  OPERATOR_KEYS?: string | undefined;
  /** One QuotaCounter per quota-relay source. */
  QUOTA: DurableObjectNamespace;
  /** The quota relay's cost dashboard. */
  QUOTA_METRICS: AnalyticsEngineDataset;
}

type Handler = (request: Request, ctx: WaitUntil) => Promise<Response>;

/**
 * Real dependencies, or null when a secret is unset or empty (an empty HMAC key throws).
 * `fetch` is wrapped: workerd refuses a call of the global fetch with another `this`.
 */
function build(env: Env): Handler | null {
  const sessionSecret = env.RELAY_SESSION_SECRET ?? '';
  const turnstileSecret = env.TURNSTILE_SECRET_KEY ?? '';
  if (sessionSecret === '' || turnstileSecret === '') return null;
  const fetchFn: typeof fetch = (input, init) => fetch(input, init);
  const hostnames = new Set(
    env.TURNSTILE_HOSTNAMES.split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  return createHandler({
    hosts: RELAY_HOSTS,
    origin: env.SITE,
    sessionSecret,
    fetch: fetchFn,
    resolve: createDohResolver({ fetch: fetchFn, now: Date.now }),
    verifyTurnstile: createTurnstileVerifier({
      fetch: fetchFn,
      secret: turnstileSecret,
      hostnames,
    }),
    limiter: env.RATE_LIMITER,
    sessionLimiter: env.SESSION_LIMITER,
    now: Date.now,
    log: writeLog,
    quota: {
      sources: QUOTA_SOURCES,
      keys: parseOperatorKeys(env.OPERATOR_KEYS),
      store: async (source, input) => {
        const counter = env.QUOTA.get(env.QUOTA.idFromName(source));
        const answer = await counter.fetch('https://quota.internal/reserve', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        return answer.json<ReserveResult>();
      },
      // Names, outcomes and statuses only: never a URL, key or IP.
      metric: ({ source, outcome, status }) => {
        env.QUOTA_METRICS.writeDataPoint({
          indexes: [source],
          blobs: [source, outcome],
          doubles: [1, status],
        });
      },
    },
  });
}

/** Built once per isolate, so the DNS verdict cache survives between requests. */
let handler: Handler | null | undefined;

export { QuotaCounter } from './quota-counter.ts';

export default {
  fetch(request, env, ctx): Promise<Response> {
    if (handler === undefined) handler = build(env);
    if (handler !== null) return handler(request, ctx);
    // Unconfigured: healthz still answers so a deploy can see the Worker is up.
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      const quota = [...parseOperatorKeys(env.OPERATOR_KEYS).keys()].sort();
      return Promise.resolve(healthzResponse(RELAY_HOSTS.size, false, quota));
    }
    return Promise.resolve(errorResponse('not_configured'));
  },
} satisfies ExportedHandler<Env>;
