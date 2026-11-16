import type { APIRoute } from 'astro';

import { MAX_CSP_REPORT_BYTES, parseCspReports } from '../lib/csp-report.ts';

// CSP report sink (P2-02): the `Content-Security-Policy-Report-Only` header the middleware
// puts on on-demand responses names this route through `report-uri` and `Reporting-Endpoints`.
// Each violation becomes one JSON line on stderr, which Workers Logs keeps (observability is on
// in wrangler.jsonc). Nothing is stored and nothing is answered beyond the status.
export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

export const POST: APIRoute = async ({ request }) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CSP_REPORT_BYTES) {
    return new Response(null, { status: 413, headers: NO_STORE });
  }
  const body = await request.text();
  if (body.length > MAX_CSP_REPORT_BYTES) {
    return new Response(null, { status: 413, headers: NO_STORE });
  }
  const reports = parseCspReports(request.headers.get('content-type'), body);
  if (reports === null) {
    return new Response(null, { status: 400, headers: NO_STORE });
  }
  for (const report of reports) {
    console.warn(JSON.stringify({ event: 'csp-report', ...report }));
  }
  return new Response(null, { status: 204, headers: NO_STORE });
};

export const ALL: APIRoute = () =>
  new Response(null, { status: 405, headers: { ...NO_STORE, allow: 'POST' } });
