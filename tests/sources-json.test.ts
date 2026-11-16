import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SOURCE_ROUTES, sourcesFileSchema } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import { repoRoot } from '../scripts/lib/policy.ts';

// The committed routing matrix (P4-S1 acceptance): `sources.json` validates, every source
// has exactly one route and a terms link. The weekly workflow rewrites the file; this test is what
// its pull request has to pass.

const file = sourcesFileSchema.parse(
  JSON.parse(readFileSync(resolve(repoRoot, 'data/sources.json'), 'utf8')),
);

test('data/sources.json validates and describes the whole upstream registry', () => {
  expect(file.upstream.repo).toBe('The-40-Thieves/alexandria-mcp');
  expect(file.upstream.sources).toBe(file.sources.length);
  expect(file.sources.length).toBeGreaterThanOrEqual(150);
});

test('every source has exactly one of the four routes and a terms link', () => {
  for (const source of file.sources) {
    expect(SOURCE_ROUTES).toContain(source.route);
    expect(() => new URL(source.terms.url)).not.toThrow();
  }
  const counted = Object.values(file.routes).reduce((sum, count) => sum + count, 0);
  expect(counted).toBe(file.sources.length);
});

test('routes follow the probe facts', () => {
  for (const source of file.sources) {
    if (source.kind === 'mcp' || source.kind === 'scrape') {
      expect(source.route).toBe('mcp-only');
      expect(source.probe.status).toBe('skipped');
    } else if (source.cors === 'open') {
      expect(source.route).toBe('browser-direct');
    } else {
      expect(['visitor-key-relay', 'quota-relay']).toContain(source.route);
      if (source.route === 'quota-relay') expect(source.key?.daily_cap).toBeGreaterThan(0);
    }
    if (source.route !== 'mcp-only' && source.probe.status === 'ok') {
      expect(source.hosts.length).toBeGreaterThan(0);
    }
  }
});

test('the file carries no request URLs, key values or timestamps', () => {
  const text = readFileSync(resolve(repoRoot, 'data/sources.json'), 'utf8');
  expect(text).not.toContain('the40thieves-probe');
  expect(text).not.toMatch(/"https?:\/\/[^"]*[?&]/);
  expect(text).not.toMatch(/"(generated_at|probed_at|timestamp)"/);
});
