import { captureException } from '@sentry/cloudflare';
import { defineMiddleware } from 'astro:middleware';

import rawPolicy from '../../../security/headers.policy.json' with { type: 'json' };

import { withRouteHeaders } from './lib/route-headers.ts';

import type { Policy } from '../../../scripts/lib/policy.ts';

// The JSON import widens `classes` to string[]; `pnpm check:headers` validates this same file
// against the Policy shape in CI, so the assertion only restores what the gate proved.
const policy = rawPolicy as Policy;

/**
 * On-demand routes only (prerendered pages are files; `_headers` covers them): report any
 * thrown error to Sentry under the request scope `withSentry` opened in the Worker entry,
 * answer it with a bare 500, and stamp the ssr-class policy headers on every response, the
 * error one included (a rethrow would let Astro's own 500 leave without them).
 */
export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered) return next();
  let response: Response;
  try {
    response = await next();
  } catch (error) {
    captureException(error);
    response = new Response('Internal Server Error', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return withRouteHeaders(response, policy, 'ssr');
});
