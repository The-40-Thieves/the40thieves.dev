import handler from '@astrojs/cloudflare/entrypoints/server';
import { captureException, withSentry } from '@sentry/cloudflare';

import rawPolicy from '../../security/headers.policy.json' with { type: 'json' };
import { createPauseCheck, type FlagStore } from '../../security/pause-flag.ts';

import { gateTryPage, isGatedPath } from './src/lib/pause-gate.ts';
import { withRouteHeaders } from './src/lib/route-headers.ts';
import { type SentryEnv, sentryOptions } from './src/lib/sentry-options.ts';

import type { Policy } from '../../scripts/lib/policy.ts';

// Same assertion as src/middleware.ts: `pnpm check:headers` validates the file in CI.
const policy = rawPolicy as Policy;

interface HubEnv extends SentryEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The kill switch namespace (P4-S5), shared with the relay; see security/pause-flag.ts. */
  FLAGS?: FlagStore;
}

type Fetch = NonNullable<ExportedHandler<HubEnv>['fetch']>;
const astro = handler as unknown as { fetch: Fetch };

/** One check per isolate, so a failed read can fall back to the last value this isolate saw. */
let paused: (() => Promise<boolean>) | undefined;

/**
 * The Astro handler behind the kill switch gate (P4-S5). Only the paths wrangler.jsonc lists
 * under `assets.run_worker_first` reach the gate; every other request is Astro's, unchanged.
 */
const gated: { fetch: Fetch } = {
  fetch(request, env, ctx) {
    if (!isGatedPath(new URL(request.url).pathname)) return astro.fetch(request, env, ctx);
    paused ??= createPauseCheck(env.FLAGS, captureException);
    return gateTryPage(request, {
      paused,
      assets: (asset) => env.ASSETS.fetch(asset),
      stamp: (response) => withRouteHeaders(response, policy, 'ssr'),
    });
  },
};

/**
 * Worker entry (wrangler `main`): the Astro Cloudflare handler wrapped with Sentry (P2-12). The
 * adapter hands this file to the Cloudflare Vite plugin, which emits it as `dist/server/entry.mjs`.
 * DSN and environment are Worker vars in wrangler.jsonc; the release is the commit the deploy job
 * passes as a var, the same name it uploads the source maps under. The options themselves live in
 * src/lib/sentry-options.ts so the unit tests can cover them.
 */
export default withSentry((env: HubEnv) => sentryOptions(env), gated);
