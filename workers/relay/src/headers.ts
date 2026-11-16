import policy from '../../../security/headers.policy.json' with { type: 'json' };

interface HeaderRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

/**
 * The `relay` route class of `security/headers.policy.json`, bundled into the Worker so the
 * policy stays the single source of truth; the deploy audits the live Worker against the same
 * file (`audit:headers --class relay`). The relay has no path-scoped rules.
 */
const RELAY_HEADERS: ReadonlyArray<readonly [string, string]> = (policy.headers as HeaderRule[])
  .filter((rule) => rule.classes.includes('relay') && rule.path === undefined)
  .map((rule) => [rule.name, rule.value] as const);

const USER_AGENT = 'the40thieves-relay/1 (+https://the40thieves.dev/alexandria/sources/)';

/** Request headers that never reach the upstream: hop-by-hop, identifying, or the relay's own. */
const DROP_EXACT = new Set([
  'host',
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'forwarded',
  'content-length',
]);

const DROP_PREFIXES = ['proxy-', 'x-relay-', 'cf-', 'x-forwarded-', 'sec-'];

/** Upstream response headers the browser may see. */
const KEEP_EXACT = new Set(['content-type', 'etag', 'last-modified', 'retry-after']);
const KEEP_PREFIX = 'x-ratelimit-';

/**
 * The headers sent upstream: the visitor's request headers less everything on the drop list
 * and anything its own `Connection` header names, with the relay's user agent. Credentials
 * (`authorization`, any key header) pass through untouched.
 */
export function upstreamHeaders(request: Headers): Headers {
  const named = new Set(
    (request.get('connection') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
  const out = new Headers();
  // Headers iterates with lower-cased names, so the comparisons below are case-insensitive.
  for (const [name, value] of request) {
    if (DROP_EXACT.has(name) || named.has(name)) continue;
    if (DROP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    out.append(name, value);
  }
  out.set('user-agent', USER_AGENT);
  return out;
}

/**
 * The headers sent to the browser: the allowlisted upstream headers, every `relay` policy
 * header, and `cache-control: no-store`. Never `content-length` or `content-encoding`: the
 * runtime may already have decoded the body.
 */
export function clientHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of upstream) {
    if (KEEP_EXACT.has(name) || name.startsWith(KEEP_PREFIX)) out.append(name, value);
  }
  for (const [name, value] of RELAY_HEADERS) out.set(name, value);
  out.set('cache-control', 'no-store');
  return out;
}
