import { createPauseCheck } from '../../../security/pause-flag.ts';

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
  /** The kill switch namespace (P4-S5), shared with the hub; see security/pause-flag.ts. */
  FLAGS?: KVNamespace | undefined;
}

type Handler = (request: Request, ctx: WaitUntil) => Promise<Response>;

/** A failed flag read is one log line with no detail: the error text could name the namespace. */
function pauseCheck(env: Env): () => Promise<boolean> {
  return createPauseCheck(env.FLAGS, () => {
    writeLog({ route: 'other', outcome: 'flag_read_failed', status: 0, ms: 0 });
  });
}

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
    paused: pauseCheck(env),
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
let unconfiguredPause: (() => Promise<boolean>) | undefined;

export { QuotaCounter } from './quota-counter.ts';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (handler === undefined) handler = build(env);
    if (handler !== null) return handler(request, ctx);
    // Unconfigured: healthz still answers so a deploy can see the Worker is up.
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      const quota = [...parseOperatorKeys(env.OPERATOR_KEYS).keys()].sort();
      unconfiguredPause ??= pauseCheck(env);
      return healthzResponse(RELAY_HOSTS.size, false, quota, await unconfiguredPause());
    }
    return errorResponse('not_configured');
  },
} satisfies ExportedHandler<Env>;
