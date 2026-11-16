import { expect, test } from 'vitest';

import sources from '../../../data/sources.json' with { type: 'json' };
import { RELAY_HOSTS, relayHosts } from '../src/allowlist.ts';

test('the committed allowlist holds the 56 visitor-key-relay hosts', () => {
  expect(RELAY_HOSTS.size).toBe(56);
  expect(RELAY_HOSTS.has('api.core.ac.uk')).toBe(true);
});

test('a quota-relay host is not on the allowlist', () => {
  const quota = sources.sources.find((s) => s.route === 'quota-relay');
  expect(quota?.hosts).toContain('www.courtlistener.com');
  expect(RELAY_HOSTS.has('www.courtlistener.com')).toBe(false);
});

test('relayHosts keeps only visitor-key-relay entries with hosts, lower-cased', () => {
  const hosts = relayHosts({
    sources: [
      { route: 'visitor-key-relay', hosts: ['API.Example.com'] },
      { route: 'browser-direct', hosts: ['direct.example.com'] },
      { route: 'visitor-key-relay', hosts: [] },
    ],
  });
  expect([...hosts]).toEqual(['api.example.com']);
});
