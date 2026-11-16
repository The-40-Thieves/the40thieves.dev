import { expect, test } from 'vitest';

import { clientHeaders, upstreamHeaders } from '../src/headers.ts';

const DROPPED = [
  'host',
  'cookie',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'x-relay-target',
  'x-relay-session',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'forwarded',
  'sec-fetch-mode',
  'sec-ch-ua',
  'content-length',
];

test('upstreamHeaders keeps the credentials and the content headers the upstream needs', () => {
  const out = upstreamHeaders(
    new Headers({
      authorization: 'Bearer k',
      'x-api-key': 'k',
      'content-type': 'application/json',
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
    }),
  );
  expect(out.get('authorization')).toBe('Bearer k');
  expect(out.get('x-api-key')).toBe('k');
  expect(out.get('content-type')).toBe('application/json');
  expect(out.get('accept')).toBe('application/json');
  expect(out.get('anthropic-version')).toBe('2023-06-01');
});

test('upstreamHeaders drops every hop-by-hop, identifying and relay header', () => {
  const input = new Headers({ authorization: 'Bearer k' });
  for (const name of DROPPED) input.set(name, 'v');
  const out = upstreamHeaders(input);
  for (const name of DROPPED) expect(out.has(name), name).toBe(false);
  expect(out.get('authorization')).toBe('Bearer k');
});

test('upstreamHeaders matches the drop list case-insensitively', () => {
  const out = upstreamHeaders(
    new Headers({ 'X-Relay-Session': 's', 'CF-Ray': 'r', 'Sec-Fetch-Site': 'cross-site' }),
  );
  expect([...out.keys()]).toEqual(['user-agent']);
});

test('upstreamHeaders drops the headers the request names in its own Connection header', () => {
  const out = upstreamHeaders(
    new Headers({ connection: 'close, X-Private-Hop', 'x-private-hop': '1', 'x-api-key': 'k' }),
  );
  expect(out.has('x-private-hop')).toBe(false);
  expect(out.has('connection')).toBe(false);
  expect(out.get('x-api-key')).toBe('k');
});

test('upstreamHeaders replaces the browser user-agent with the relay one', () => {
  const out = upstreamHeaders(new Headers({ 'user-agent': 'Mozilla/5.0' }));
  expect(out.get('user-agent')).toBe(
    'the40thieves-relay/1 (+https://the40thieves.dev/alexandria/sources/)',
  );
});

test('clientHeaders keeps only the allowlisted upstream headers', () => {
  const out = clientHeaders(
    new Headers({
      'content-type': 'application/json',
      etag: '"abc"',
      'last-modified': 'Mon, 10 Nov 2026 00:00:00 GMT',
      'retry-after': '30',
      'x-ratelimit-remaining': '9',
      'X-RateLimit-Reset': '60',
      'set-cookie': 'session=1',
      'access-control-allow-origin': '*',
      location: 'https://elsewhere.example/',
      'content-encoding': 'gzip',
      'content-length': '10',
      server: 'upstream',
    }),
  );
  expect(out.get('content-type')).toBe('application/json');
  expect(out.get('etag')).toBe('"abc"');
  expect(out.get('last-modified')).toBe('Mon, 10 Nov 2026 00:00:00 GMT');
  expect(out.get('retry-after')).toBe('30');
  expect(out.get('x-ratelimit-remaining')).toBe('9');
  expect(out.get('x-ratelimit-reset')).toBe('60');
  for (const name of [
    'set-cookie',
    'access-control-allow-origin',
    'location',
    'content-encoding',
    'content-length',
    'server',
  ]) {
    expect(out.has(name), name).toBe(false);
  }
});

test('clientHeaders carries the relay policy headers and no-store', () => {
  const out = clientHeaders(new Headers({ 'cache-control': 'public, max-age=600' }));
  expect(out.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains; preload');
  expect(out.get('x-content-type-options')).toBe('nosniff');
  expect(out.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(out.get('x-frame-options')).toBe('DENY');
  expect(out.get('referrer-policy')).toBe('no-referrer');
  expect(out.get('cross-origin-resource-policy')).toBe('cross-origin');
  expect(out.get('cache-control')).toBe('no-store');
});
