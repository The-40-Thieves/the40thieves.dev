import MiniSearch from 'minisearch';
import { expect, test } from 'vitest';

import {
  buildDocsIndex,
  DOCS_INDEX_OPTIONS,
  docsIndexSchema,
  docTitle,
  loadDocsIndex,
  type DocsDocument,
  type DocsIndex,
} from '@the40thieves/manifest';

const twins = [
  {
    path: '/codecalc.md',
    text: '# codecalc\n\n> A calculator, a code runner and a logic checker for AI agents.\n\n## Install\n\nuvx codecalc\n',
  },
  {
    path: '/audio-forge.md',
    text: '# audio-forge\n\n> An audio delivery pipeline AI agents can drive.\n',
  },
  { path: '/AGENTS.md', text: 'No heading here, only a sentence about the hub.' },
];

test('docTitle is the first level-one heading, else the path', () => {
  expect(docTitle('/codecalc.md', '# codecalc\n\nbody')).toBe('codecalc');
  expect(docTitle('/x.md', 'plain text\n## not level one')).toBe('/x.md');
});

test('buildDocsIndex stores every document and a MiniSearch index that finds them', () => {
  const index: DocsIndex = buildDocsIndex(twins, '2026-11-05T22:00:00.000Z');
  expect(docsIndexSchema.parse(index)).toEqual(index);
  expect(index.documents.map((doc) => doc.path)).toEqual([
    '/AGENTS.md',
    '/audio-forge.md',
    '/codecalc.md',
  ]);
  expect(index.documents.find((doc) => doc.path === '/codecalc.md')?.title).toBe('codecalc');
  const search = MiniSearch.loadJSON<DocsDocument>(JSON.stringify(index.index), DOCS_INDEX_OPTIONS);
  expect(search.search('calculator')[0]?.id).toBe('/codecalc.md');
  expect(search.search('audio delivery')[0]?.id).toBe('/audio-forge.md');
});

test('loadDocsIndex round-trips the JSON into a searchable index and a document map', () => {
  const index = buildDocsIndex(twins, '2026-11-05T22:00:00.000Z');
  const loaded = loadDocsIndex(JSON.parse(JSON.stringify(index)) as unknown);
  expect(loaded.search.search('logic checker')[0]?.id).toBe('/codecalc.md');
  expect(loaded.documents.get('/AGENTS.md')?.text).toContain('sentence about the hub');
  expect(() => loadDocsIndex({ version: 2 })).toThrow(/docs index/);
});

test('buildDocsIndex is deterministic for the same documents and timestamp', () => {
  const a = buildDocsIndex(twins, '2026-11-05T22:00:00.000Z');
  const b = buildDocsIndex([...twins].reverse(), '2026-11-05T22:00:00.000Z');
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
