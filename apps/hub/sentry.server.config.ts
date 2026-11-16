import handler from '@astrojs/cloudflare/entrypoints/server';
import { withSentry } from '@sentry/cloudflare';

import { type SentryEnv, sentryOptions } from './src/lib/sentry-options.ts';

/**
 * Worker entry (wrangler `main`): the Astro Cloudflare handler wrapped with Sentry (P2-12). The
 * adapter hands this file to the Cloudflare Vite plugin, which emits it as `dist/server/entry.mjs`.
 * DSN and environment are Worker vars in wrangler.jsonc; the release is the commit the deploy job
 * passes as a var, the same name it uploads the source maps under. The options themselves live in
 * src/lib/sentry-options.ts so the unit tests can cover them.
 */
export default withSentry((env: SentryEnv) => sentryOptions(env), handler);
