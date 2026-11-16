import { expect, test } from 'vitest';

import {
  SOURCE_ROUTES,
  SOURCES_SCHEMA_ID,
  sourcesFileSchema,
  sourcesJsonSchemaDocument,
  type SourceEntry,
} from '@the40thieves/schemas';

// data/sources.json (P4-S1) is the routing matrix the relay and the BYOK app read. The
// schema is what "sources.json validates" means in the acceptance line: one route per source,
// a terms link per source, and counts that agree with the entries.

const alpha: SourceEntry = {
  name: 'alpha',
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  description: 'Alpha search.',
  key: null,
  cors: 'open',
  hosts: ['api.alpha.example'],
  terms: { url: 'https://alpha.example/terms', ingest: 'allowed' },
  route: 'browser-direct',
  probe: { status: 'ok', detail: null },
};

const bravo: SourceEntry = {
  name: 'bravo',
  kind: 'rest',
  cluster: 'news_global',
  freshness: 'realtime',
  description: 'Bravo news.',
  key: { env: 'BRAVO_KEY', type: 'header', daily_cap: 100 },
  cors: 'closed',
  hosts: ['api.bravo.example'],
  terms: { url: 'https://bravo.example/', ingest: 'timeboxed' },
  route: 'quota-relay',
  probe: { status: 'ok', detail: 'HTTP 401' },
};

const file = {
  $schema: SOURCES_SCHEMA_ID,
  version: 1,
  origin: 'https://the40thieves.dev',
  upstream: {
    repo: 'The-40-Thieves/alexandria-mcp',
    commit: '0be8f2c3014380f61a7a102406fb61e4a5c61f5a',
    sources: 2,
  },
  routes: { 'browser-direct': 1, 'visitor-key-relay': 0, 'quota-relay': 1, 'mcp-only': 0 },
  sources: [alpha, bravo],
};

test('a well-formed sources file parses', () => {
  const parsed = sourcesFileSchema.parse(file);
  expect(parsed.sources.map((s) => s.route)).toEqual(['browser-direct', 'quota-relay']);
  expect(parsed.upstream.sources).toBe(2);
});

test('route counts that disagree with the entries are rejected', () => {
  const result = sourcesFileSchema.safeParse({
    ...file,
    routes: { ...file.routes, 'browser-direct': 2 },
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).toContain('routes');
});

test('an upstream count that disagrees with the entries is rejected', () => {
  const result = sourcesFileSchema.safeParse({
    ...file,
    upstream: { ...file.upstream, sources: 3 },
  });
  expect(result.success).toBe(false);
});

test('entries must be unique and sorted by name', () => {
  expect(sourcesFileSchema.safeParse({ ...file, sources: [bravo, alpha] }).success).toBe(false);
  const dup = { ...file, sources: [alpha, { ...bravo, name: 'alpha' }] };
  expect(sourcesFileSchema.safeParse(dup).success).toBe(false);
});

test('a terms link must be a URL and a route one of the four', () => {
  const badTerms = { ...alpha, terms: { url: 'not a url', ingest: 'allowed' } };
  expect(sourcesFileSchema.safeParse({ ...file, sources: [badTerms, bravo] }).success).toBe(false);
  const badRoute = { ...alpha, route: 'direct' };
  expect(sourcesFileSchema.safeParse({ ...file, sources: [badRoute, bravo] }).success).toBe(false);
  expect(SOURCE_ROUTES).toEqual(['browser-direct', 'visitor-key-relay', 'quota-relay', 'mcp-only']);
});

test('the published JSON Schema names itself and the four routes', () => {
  const doc = sourcesJsonSchemaDocument();
  expect(doc.$id).toBe('https://the40thieves.dev/schemas/sources.json');
  expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(JSON.stringify(doc)).toContain('"visitor-key-relay"');
});
