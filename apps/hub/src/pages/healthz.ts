import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { boomAllowed } from '../lib/healthz-boom.ts';

// The one on-demand route: synthetic checks read it, and `?boom=1` throws on purpose so the
// Sentry wiring (P2-12) can be exercised end to end. The throw is gated on the optional
// `HEALTHZ_BOOM_TOKEN` Worker secret sent in `x-healthz-boom`; without it the query is ignored.
// The middleware adds the ssr headers.
export const prerender = false;

export const GET: APIRoute = ({ url, request }) => {
  if (
    url.searchParams.get('boom') === '1' &&
    boomAllowed(request.headers.get('x-healthz-boom'), env.HEALTHZ_BOOM_TOKEN)
  ) {
    throw new Error('healthz boom: deliberate test error');
  }
  const info = __BUILD_INFO__;
  return new Response(
    JSON.stringify({ status: 'ok', commit: info.commit, built_at: info.generatedAt }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
};
