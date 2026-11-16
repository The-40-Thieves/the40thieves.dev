/**
 * PostHog page views without posthog-js (P2-12): one anonymous `$pageview` per page load, sent
 * from `src/scripts/pageview.ts`. No autocapture, no cookies, no person profile, no IP (the
 * `ip=0` query on the capture URL), and only `utm_*` from the query string. The hub shares the
 * one PostHog project the plan allows, so every insight filters on `$host`.
 */

/** PostHog US cloud ingest host; the CSP `connect-src` allows exactly this origin. */
export const POSTHOG_HOST = 'https://us.i.posthog.com';

/** Project token (a client-side key by design, not a secret). Project 384126 "the13thletter". */
export const POSTHOG_TOKEN = 'phc_rHvvX6ms5pVinunNhZWvTnoAv6AoeQR24gsJBU7bukXj';

/** The capture endpoint for a single event, with IP capture disabled. */
export const POSTHOG_CAPTURE_URL = `${POSTHOG_HOST}/i/v0/e/?ip=0`;

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

export interface PageviewInput {
  url: string;
  referrer: string;
  distinctId: string;
  now: string;
}

export interface PostHogEvent {
  api_key: string;
  event: '$pageview';
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | boolean>;
}

/**
 * The page URL as sent: origin, path and the `utm_*` parameters only. The fragment and every
 * other query parameter are dropped before anything is serialized, so an identifier or token in
 * the address bar never reaches PostHog, whatever the other properties say.
 */
export function sanitizedPageUrl(url: URL): string {
  const clean = new URL(url.origin + url.pathname);
  for (const key of UTM_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') clean.searchParams.set(key, value);
  }
  return clean.href;
}

/** The referrer as sent: origin and path, no query, no fragment. */
export function sanitizedReferrer(referrer: string): URL | undefined {
  if (referrer === '') return undefined;
  try {
    const url = new URL(referrer);
    return new URL(url.origin + url.pathname);
  } catch {
    // A malformed referrer is not recorded at all rather than passed through raw.
    return undefined;
  }
}

/** Build the `$pageview` payload for one page load. Pure, so the tests cover it in Node. */
export function pageviewEvent(input: PageviewInput): PostHogEvent {
  const url = new URL(input.url);
  const properties: Record<string, string | boolean> = {
    $process_person_profile: false,
    $lib: 'the40thieves-hub',
    $current_url: sanitizedPageUrl(url),
    $host: url.host,
    $pathname: url.pathname,
  };
  const referrer = sanitizedReferrer(input.referrer);
  if (referrer !== undefined) {
    properties['$referrer'] = referrer.href;
    properties['$referring_domain'] = referrer.host;
  }
  for (const key of UTM_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') properties[key] = value;
  }
  return {
    api_key: POSTHOG_TOKEN,
    event: '$pageview',
    distinct_id: input.distinctId,
    timestamp: input.now,
    properties,
  };
}
