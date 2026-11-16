/** Path of the hub's CSP report sink (an on-demand Worker route, `apps/hub/src/pages/csp-report.ts`). */
export const CSP_REPORT_PATH = '/csp-report';

/** Reporting API group name the `Reporting-Endpoints` header binds to that path. */
export const CSP_REPORT_GROUP = 'csp-endpoint';

/**
 * Render the `Content-Security-Policy-Report-Only` value for on-demand responses from the
 * directive file Astro also merges into the hashed `<meta>` of prerendered pages
 * (`security/csp.directives.json`).
 *
 * Prerendered pages carry their CSP in a `<meta>` because the hashes are per page, and a meta
 * policy cannot report. On-demand responses (JSON today) get this header instead: the same
 * directives plus host-only `script-src` and `style-src` (no hashes exist for them),
 * `frame-ancestors 'none'` to mirror the enforced header, and both reporting directives
 * (`report-uri` for browsers without the Reporting API). `upgrade-insecure-requests` is dropped:
 * it has no effect in a report-only policy and browsers warn about it.
 */
export function reportOnlyPolicy(directives: readonly string[]): string {
  return [
    ...directives.filter((directive) => directive !== 'upgrade-insecure-requests'),
    "script-src 'self'",
    "style-src 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join('; ');
}
