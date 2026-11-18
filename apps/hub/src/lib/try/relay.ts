import type { TrySource, UpstreamRequest } from './sources.ts';

/**
 * How one upstream call leaves the browser (P4-S4). Browser-direct sources are fetched as
 * they are; the others go to the relay (P4-S2, P4-S3), which needs a session minted from a
 * Turnstile token. The page holds that session in memory only.
 */

export const RELAY_ORIGIN = 'https://relay.the40thieves.dev';

/** The relay widget's public sitekey (Turnstile "the40thieves.dev relay", hostname-bound). */
export const TURNSTILE_SITEKEY = '0x4AAAAAAF7J5PmKIfD8a8Gj';
/** Cloudflare's always-passing test sitekey, for every host but production. */
export const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';
export const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function sitekeyFor(hostname: string): string {
  return hostname === 'the40thieves.dev' ? TURNSTILE_SITEKEY : TURNSTILE_TEST_SITEKEY;
}

/** Every origin the page may connect to; the page CSP lists exactly these (plus 'self'). */
export const CONNECT_ORIGINS: readonly string[] = [
  RELAY_ORIGIN,
  'https://api.openalex.org',
  'https://api.crossref.org',
  'https://www.ebi.ac.uk',
  'https://api.anthropic.com',
  'https://api.openai.com',
];

export interface RoutedRequest {
  url: string;
  init: RequestInit;
}

/** The fetch that carries `upstream` for `source`, given a relay session when one is needed. */
export function routeRequest(
  source: TrySource,
  upstream: UpstreamRequest,
  session: string | null,
): RoutedRequest {
  if (source.route === 'browser-direct') {
    return { url: upstream.url, init: { headers: upstream.headers, credentials: 'omit' } };
  }
  if (session === null)
    throw new Error(`${source.name} goes through the relay and needs a session`);
  const headers = {
    ...upstream.headers,
    'x-relay-target': upstream.url,
    'x-relay-session': session,
  };
  const path = source.route === 'quota-relay' ? `/v1/quota/${source.name}` : '/v1/fetch';
  return {
    url: `${RELAY_ORIGIN}${path}`,
    init: { headers, credentials: 'omit', referrerPolicy: 'no-referrer' },
  };
}

export interface RelaySession {
  session: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Re-mint this long before the relay's expiry, so a search never starts on a dying session. */
const EXPIRY_MARGIN_MS = 60_000;

export function sessionIsFresh(session: RelaySession | null, now: number): boolean {
  return session !== null && session.expiresAt - EXPIRY_MARGIN_MS > now;
}

/** Trade a Turnstile token for a relay session (`POST /v1/session`). */
export async function mintSession(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<RelaySession> {
  const response = await fetcher(`${RELAY_ORIGIN}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`the relay refused a session (${String(response.status)})`);
  const body: unknown = await response.json();
  const value = body as { session?: unknown; expires_at?: unknown };
  if (typeof value.session !== 'string' || typeof value.expires_at !== 'number') {
    throw new Error('the relay answered a session request with an unexpected body');
  }
  return { session: value.session, expiresAt: value.expires_at * 1000 };
}

/** Why a source returned nothing, in words a visitor can act on. */
export function failureText(
  status: number,
  retryAfter: string | null,
  code: string | null = null,
): string {
  if (code === 'rate_limited') return 'Too many requests this minute; wait a moment.';
  if (status === 429 && code !== 'quota_reached') {
    // The upstream's own limit, passed through the relay (keyless Semantic Scholar shares one
    // throttled pool): not the site's daily allowance, which only quota sources have.
    const wait = Number(retryAfter);
    if (!Number.isFinite(wait) || wait <= 0) {
      return 'The source is limiting requests right now; try again shortly.';
    }
    const after =
      wait < 90 ? 'in about a minute' : `in about ${String(Math.ceil(wait / 60))} minutes`;
    return `The source is limiting requests right now; try again ${after}.`;
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    const hours = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 3600) : null;
    return hours === null
      ? 'Daily allowance used up; try again later.'
      : `Daily allowance used up; resets in about ${String(hours)} h.`;
  }
  if (status === 401 || status === 403) return 'Refused: check the key, or the relay session.';
  if (code === 'paused') return 'The relay is paused for now; try again later.';
  if (status === 503) return 'Not configured on the relay yet.';
  return `The source answered ${String(status)}.`;
}
