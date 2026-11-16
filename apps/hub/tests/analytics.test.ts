import { expect, test } from 'vitest';

import { POSTHOG_HOST, pageviewEvent } from '../src/lib/analytics.ts';

const page = {
  url: 'https://the40thieves.dev/codecalc/?utm_source=test&utm_medium=social&utm_campaign=launch&ref=x',
  referrer: 'https://news.ycombinator.com/item?id=1',
  distinctId: 'session-1',
  now: '2026-11-03T13:00:00.000Z',
};

test('pageviewEvent is an anonymous $pageview carrying the url parts and the utm parameters', () => {
  const event = pageviewEvent(page);
  expect(event.event).toBe('$pageview');
  expect(event.distinct_id).toBe('session-1');
  expect(event.timestamp).toBe('2026-11-03T13:00:00.000Z');
  expect(event.properties).toMatchObject({
    $process_person_profile: false,
    // Sent without `ref=x`: only the utm parameters survive in the url itself.
    $current_url:
      'https://the40thieves.dev/codecalc/?utm_source=test&utm_medium=social&utm_campaign=launch',
    $host: 'the40thieves.dev',
    $pathname: '/codecalc/',
    $referrer: 'https://news.ycombinator.com/item',
    $referring_domain: 'news.ycombinator.com',
    utm_source: 'test',
    utm_medium: 'social',
    utm_campaign: 'launch',
  });
  // Only utm_* survive from the query string; anything else could carry identifiers.
  expect(event.properties).not.toHaveProperty('ref');
  expect(JSON.stringify(event)).not.toContain('ref=x');
});

test('pageviewEvent omits referrer and utm keys that are absent', () => {
  const event = pageviewEvent({ ...page, url: 'https://the40thieves.dev/', referrer: '' });
  expect(event.properties).not.toHaveProperty('$referrer');
  expect(event.properties).not.toHaveProperty('$referring_domain');
  expect(event.properties).not.toHaveProperty('utm_source');
  expect(event.properties['$pathname']).toBe('/');
});

test('pageviewEvent strips the fragment and every non-utm query parameter from $current_url', () => {
  const event = pageviewEvent({
    ...page,
    url: 'https://the40thieves.dev/?email=visitor%40example.com&utm_source=test#access_token=secret',
  });
  expect(event.properties['$current_url']).toBe('https://the40thieves.dev/?utm_source=test');
  expect(JSON.stringify(event)).not.toContain('visitor');
  expect(JSON.stringify(event)).not.toContain('access_token');
});

test('pageviewEvent keeps only origin and path of the referrer', () => {
  const event = pageviewEvent({
    ...page,
    referrer: 'https://the40thieves.dev/codecalc/?session=abc#token=xyz',
  });
  expect(event.properties['$referrer']).toBe('https://the40thieves.dev/codecalc/');
  expect(event.properties['$referring_domain']).toBe('the40thieves.dev');
  expect(JSON.stringify(event)).not.toContain('abc');
});

test('pageviewEvent records a malformed referrer as nothing at all', () => {
  const event = pageviewEvent({ ...page, referrer: 'not a url' });
  expect(event.properties).not.toHaveProperty('$referrer');
  expect(event.properties).not.toHaveProperty('$referring_domain');
});

test('the PostHog ingest host is the US cloud', () => {
  expect(POSTHOG_HOST).toBe('https://us.i.posthog.com');
});
