import { expect, test } from 'vitest';

import {
  activeTrialTokens,
  decodeTrialToken,
  SITE_TRIAL_ORIGIN,
  TRIAL_ENTRIES,
} from '../src/lib/origin-trials.ts';

// P3-S4 / O-13: Origin Trial tokens are public values in security/origin-trials.json. The
// layout prints only tokens that are for this origin and have not expired.

/** A token shaped like Chromium's: version byte, 64 signature bytes, length, JSON payload. */
function token(payload: Record<string, unknown> | string, version = 3): string {
  const json = utf8(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const size = json.length;
  const length = [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255];
  return base64([version, ...filled(64, 7), ...length, ...json]);
}

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];
const filled = (count: number, byte: number): number[] => Array<number>(count).fill(byte);
const base64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

const NOW = Date.UTC(2026, 10, 9);
const LATER = Math.floor(Date.UTC(2027, 2, 29) / 1000);
const EARLIER = Math.floor(Date.UTC(2026, 9, 1) / 1000);
const live = token({ origin: SITE_TRIAL_ORIGIN, feature: 'WebMCP', expiry: LATER });

test('a token decodes to its origin, feature and expiry', () => {
  expect(SITE_TRIAL_ORIGIN).toBe('https://the40thieves.dev:443');
  expect(decodeTrialToken(live)).toEqual({
    origin: 'https://the40thieves.dev:443',
    feature: 'WebMCP',
    expiry: LATER,
    isSubdomain: false,
  });
  expect(
    decodeTrialToken(
      token({ origin: SITE_TRIAL_ORIGIN, feature: 'X', expiry: 1, isSubdomain: true }, 2),
    ).isSubdomain,
  ).toBe(true);
});

test('anything that is not a well-formed token throws', () => {
  const bad = [
    '',
    'not base64 !!!',
    base64(utf8('short')),
    // The declared length runs past the end.
    base64([3, ...filled(64, 0), 0, 0, 1, 0, ...utf8('{}')]),
    token('not json'),
    token({ origin: SITE_TRIAL_ORIGIN, feature: 'WebMCP' }),
    token({ origin: 7, feature: 'WebMCP', expiry: LATER }),
    token({ origin: SITE_TRIAL_ORIGIN, feature: 'WebMCP', expiry: LATER }, 9),
  ];
  for (const value of bad) expect(() => decodeTrialToken(value), value).toThrow();
});

test('only live tokens for this origin are active', () => {
  const expired = token({ origin: SITE_TRIAL_ORIGIN, feature: 'WebMCP', expiry: EARLIER });
  const foreign = token({ origin: 'https://example.com:443', feature: 'WebMCP', expiry: LATER });
  expect(activeTrialTokens([expired, live, foreign, 'garbage'], NOW)).toEqual([live]);
  expect(activeTrialTokens([], NOW)).toEqual([]);
  // The second a token expires it is gone.
  expect(activeTrialTokens([live], LATER * 1000)).toEqual([]);
});

test('every committed token is a well-formed token for this origin', () => {
  for (const entry of TRIAL_ENTRIES) {
    expect(['chrome', 'edge'], entry.token.slice(0, 12)).toContain(entry.browser);
    expect(decodeTrialToken(entry.token).origin).toBe(SITE_TRIAL_ORIGIN);
  }
});

// O-13: the Chrome and Edge WebMCP trials. The page gate treats any printed token as the WebMCP
// switch, so this file may hold WebMCP tokens only; another trial's token needs its own gate.
// The expiries are pinned as data: when a trial is renewed, the new token and this table change
// together, and an expired token simply stops being printed at the next build.
test('the committed tokens are the Chrome and Edge WebMCP trials', () => {
  const committed = TRIAL_ENTRIES.map((entry) => ({
    browser: entry.browser,
    ...decodeTrialToken(entry.token),
  }));
  expect(committed).toEqual([
    {
      browser: 'chrome',
      origin: SITE_TRIAL_ORIGIN,
      feature: 'WebMCP',
      expiry: Date.UTC(2027, 2, 30) / 1000,
      isSubdomain: true,
    },
    {
      browser: 'edge',
      origin: SITE_TRIAL_ORIGIN,
      feature: 'WebMCP',
      expiry: 1797670696, // 2026-12-19T08:58:16Z
      isSubdomain: true,
    },
  ]);
});
