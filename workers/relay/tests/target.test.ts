import { expect, test } from 'vitest';

import { parseTarget } from '../src/target.ts';

const hosts = new Set(['api.core.ac.uk']);
const base = 'https://api.core.ac.uk/';

test('an allowed https URL is ok and keeps path and query', () => {
  const result = parseTarget('https://api.core.ac.uk/v3/search?q=a', hosts);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.url.pathname).toBe('/v3/search');
    expect(result.url.search).toBe('?q=a');
  }
});

test('the hostname is compared after the URL parser lower-cases it', () => {
  expect(parseTarget('https://API.CORE.AC.UK/', hosts).ok).toBe(true);
});

test.each([
  ['null', null],
  ['empty', ''],
  ['not a url', 'not a url'],
  ['http', 'http://api.core.ac.uk/'],
  ['a port', 'https://api.core.ac.uk:8443/'],
  ['userinfo', 'https://user:pw@api.core.ac.uk/'],
  ['userinfo hiding the real host', 'https://api.core.ac.uk@evil.test/'],
  ['4097 characters', base + 'a'.repeat(4097 - base.length)],
])('%s is bad_target', (_name, value) => {
  expect(parseTarget(value, hosts)).toEqual({ ok: false, error: 'bad_target' });
});

test('a 4096-character value is still parsed', () => {
  const value = base + 'a'.repeat(4096 - base.length);
  expect(value.length).toBe(4096);
  expect(parseTarget(value, hosts).ok).toBe(true);
});

test.each([
  ['an IPv4 literal', 'https://10.0.0.1/'],
  ['an IPv6 literal', 'https://[::1]/'],
  ['a trailing-dot host', 'https://api.core.ac.uk./'],
  ['another host', 'https://evil.test/'],
])('%s is host_not_allowed', (_name, value) => {
  expect(parseTarget(value, hosts)).toEqual({ ok: false, error: 'host_not_allowed' });
});
