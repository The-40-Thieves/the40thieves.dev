/** Longest `X-Relay-Target` value accepted, in characters. */
export const MAX_TARGET_LENGTH = 4096;

export type TargetResult =
  { ok: true; url: URL } | { ok: false; error: 'bad_target' | 'host_not_allowed' };

/**
 * Parse the `X-Relay-Target` header. Only an absolute https URL without port or userinfo is well formed;
 * of those, only a hostname exactly in `hosts` is allowed (the URL parser has already lower-cased it).
 */
export function parseTarget(header: string | null, hosts: ReadonlySet<string>): TargetResult {
  if (header === null || header === '' || header.length > MAX_TARGET_LENGTH) {
    return { ok: false, error: 'bad_target' };
  }
  let url: URL;
  try {
    url = new URL(header);
  } catch {
    return { ok: false, error: 'bad_target' };
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return { ok: false, error: 'bad_target' };
  }
  if (!hosts.has(url.hostname)) return { ok: false, error: 'host_not_allowed' };
  return { ok: true, url };
}
