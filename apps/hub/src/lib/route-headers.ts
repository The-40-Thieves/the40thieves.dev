import type { Policy, RouteClass } from '../../../../scripts/lib/policy.ts';

/**
 * Return a copy of `response` carrying every header of `cls` from the policy. Prerendered pages
 * get theirs from `_headers`; on-demand routes (`ssr`) get them here, in the middleware, since
 * Workers static-asset headers never apply to Worker-generated responses.
 */
export function withRouteHeaders(response: Response, policy: Policy, cls: RouteClass): Response {
  const headers = new Headers(response.headers);
  for (const rule of policy.headers) {
    if (rule.classes.includes(cls)) headers.set(rule.name, rule.value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
