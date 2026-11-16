import type { BuildInfo } from '@the40thieves/manifest';
import { SOURCES_SCHEMA_ID, type SourcesFile } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import { sourcesLd } from '../src/lib/json-ld.ts';
import { sourcesTwin } from '../src/lib/twins.ts';

// The `/alexandria/sources/` page (P4-S1) renders data/sources.json: its Markdown twin and
// JSON-LD are pure functions of the file, pinned here on a two-entry fixture rather than the real
// 152-entry file so a weekly probe run never changes what this test expects.

const build: BuildInfo = {
  generatedAt: '2026-11-09T21:00:00.000Z',
  commit: 'c'.repeat(40),
  site: 'https://the40thieves.dev',
};

const file: SourcesFile = {
  $schema: SOURCES_SCHEMA_ID,
  version: 1,
  origin: 'https://the40thieves.dev',
  upstream: {
    repo: 'The-40-Thieves/alexandria-mcp',
    commit: '0be8f2c3014380f61a7a102406fb61e4a5c61f5a',
    sources: 2,
  },
  routes: { 'browser-direct': 1, 'visitor-key-relay': 0, 'quota-relay': 1, 'mcp-only': 0 },
  sources: [
    {
      name: 'crossref',
      kind: 'rest',
      cluster: 'academic',
      freshness: 'daily',
      description: 'Crossref: DOI metadata | reference lists.',
      key: null,
      cors: 'open',
      hosts: ['api.crossref.org'],
      terms: { url: 'https://www.crossref.org', ingest: 'allowed' },
      route: 'browser-direct',
      probe: { status: 'ok', detail: null },
    },
    {
      name: 'guardian',
      kind: 'rest',
      cluster: 'news_global',
      freshness: 'realtime',
      description: 'The Guardian Open Platform.',
      key: { env: 'GUARDIAN_API_KEY', type: 'query', daily_cap: 450 },
      cors: 'closed',
      hosts: ['content.guardianapis.com'],
      terms: { url: 'https://open-platform.theguardian.com/', ingest: 'timeboxed' },
      route: 'quota-relay',
      probe: { status: 'ok', detail: 'HTTP 401' },
    },
  ],
};

test('sourcesTwin renders the counts, one row per source and the data links', () => {
  const md = sourcesTwin(file, build);
  expect(md).toContain('# alexandria sources');
  expect(md).toContain('2 sources');
  expect(md).toContain('1 browser-direct');
  expect(md).toContain('1 quota-relay');
  expect(md).toContain('## academic');
  expect(md).toContain('## news_global');
  // The source cell links the terms URL; pipes in the description are escaped for the table.
  expect(md).toContain(
    '| [crossref](https://www.crossref.org) | rest | none | open | browser-direct | api.crossref.org |',
  );
  expect(md).toContain(
    '| [guardian](https://open-platform.theguardian.com/) | rest | GUARDIAN_API_KEY (450/day) | closed | quota-relay | content.guardianapis.com |',
  );
  expect(md).toContain('Crossref: DOI metadata \\| reference lists.');
  expect(md).toContain(`${build.site}/alexandria/sources.json`);
  expect(md).toContain(`${build.site}/schemas/sources.json`);
  expect(md).toContain(
    'https://github.com/The-40-Thieves/alexandria-mcp/tree/0be8f2c3014380f61a7a102406fb61e4a5c61f5a',
  );
  expect(md).toContain(`HTML version: ${build.site}/alexandria/sources/`);
  expect(md).toContain(`${build.site}/index.md`);
});

test('sourcesLd is a Dataset whose distribution is the JSON route', () => {
  const ld = sourcesLd(file, build) as {
    '@type': string;
    url: string;
    distribution: { contentUrl: string; encodingFormat: string };
    isPartOf: { url: string };
  };
  expect(ld['@type']).toBe('Dataset');
  expect(ld.url).toBe(`${build.site}/alexandria/sources/`);
  expect(ld.distribution.contentUrl).toBe(`${build.site}/alexandria/sources.json`);
  expect(ld.distribution.encodingFormat).toBe('application/json');
  expect(ld.isPartOf.url).toBe(`${build.site}/`);
});
