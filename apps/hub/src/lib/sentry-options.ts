import type { CloudflareOptions } from '@sentry/cloudflare';

/** Worker vars the Sentry entry reads: wrangler.jsonc vars, the deploy-time `--var`, or e2e overrides. */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}

/**
 * Sentry options for the hub Worker (P2-12): errors only, no PII. An empty or missing DSN leaves
 * `dsn` unset, which the SDK treats as "do not send", so `wrangler dev --var SENTRY_DSN:` (the
 * Playwright webServer) and a blank `.dev.vars` never report to the production project.
 */
export function sentryOptions(env: SentryEnv): CloudflareOptions {
  const options: CloudflareOptions = {
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    // Errors only: no tracing.
    tracesSampleRate: 0,
    // No PII: an event carries the error, the stack and the request method and path, nothing
    // about the visitor (SDK v11 replaced `sendDefaultPii` with this per-category block).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  };
  // Optional fields are set only when present: `exactOptionalPropertyTypes` forbids `undefined`.
  if (env.SENTRY_DSN) options.dsn = env.SENTRY_DSN;
  if (env.SENTRY_RELEASE) options.release = env.SENTRY_RELEASE;
  return options;
}
