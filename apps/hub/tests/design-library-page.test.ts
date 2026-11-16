import type { BuildInfo } from '@the40thieves/manifest';
import {
  DESIGN_LIBRARY_SCHEMA_ID,
  designLibrarySchema,
  type DesignLibrary,
} from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import { designLibraryLd } from '../src/lib/json-ld.ts';
import { designLibraryTwin } from '../src/lib/twins.ts';

// The `/design/library/` page renders data/design-library.json: its Markdown twin and JSON-LD
// are pure functions of the file, pinned here on a small fixture so a data refresh never changes
// what this test expects.

const build: BuildInfo = {
  generatedAt: '2026-11-10T12:00:00.000Z',
  commit: 'c'.repeat(40),
  site: 'https://the40thieves.dev',
};

const file: DesignLibrary = {
  $schema: DESIGN_LIBRARY_SCHEMA_ID,
  version: 1,
  verified: '2026-11-10',
  categories: [
    { id: 'motion', name: 'Animation and motion', intro: 'Animation engines.' },
    { id: 'empty', name: 'Empty', intro: 'Nothing here.' },
  ],
  items: [
    {
      title: 'Remotion',
      url: 'https://github.com/remotion-dev/remotion',
      category: 'motion',
      blurb: 'Video in React.',
      use: 'conditions',
      licence: 'Remotion License',
      terms: 'https://www.remotion.dev/docs/license/pricing',
      note: 'Company licence above 3 people.',
      check: 'ok',
    },
    {
      title: 'Midjourney | plans',
      url: 'https://www.midjourney.com/',
      category: 'motion',
      blurb: null,
      use: 'study',
      licence: null,
      terms: null,
      note: null,
      check: 'bot-wall',
    },
  ],
  removed: [{ title: 'Old page', url: 'https://example.com/', reason: 'Sign-in wall.' }],
};

test('the fixture is a valid file', () => {
  expect(designLibrarySchema.parse(file)).toEqual(file);
});

test('the schema rejects an unknown category and a duplicate url', () => {
  const [first] = file.items;
  const bad = { ...file, items: [first, { ...first, category: 'nope' }] };
  const result = designLibrarySchema.safeParse(bad);
  expect(result.success).toBe(false);
  const messages = result.error?.issues.map((issue) => issue.message) ?? [];
  expect(messages).toContain('unknown category nope');
  expect(messages.some((m) => m.startsWith('duplicate url'))).toBe(true);
});

test('designLibraryTwin renders the counts, one row per item and the data links', () => {
  const md = designLibraryTwin(file, build);
  expect(md).toContain('# Design resource library');
  expect(md).toContain('2 resources: 0 clear, 1 conditions, 1 study.');
  expect(md).toContain('## Animation and motion (2)');
  expect(md).not.toContain('## Empty');
  expect(md).toContain(
    '| [Remotion](https://github.com/remotion-dev/remotion) | github.com | conditions | Remotion License ([terms](https://www.remotion.dev/docs/license/pricing)) | Company licence above 3 people. |',
  );
  // Pipes in titles are escaped; a bot-walled link says how it was confirmed.
  expect(md).toContain(
    '| [Midjourney \\| plans](https://www.midjourney.com/) | midjourney.com | study | none | Confirmed through a browser fetch. |',
  );
  expect(md).toContain('- Old page: Sign-in wall.');
  expect(md).toContain(`HTML version: ${build.site}/design/library/`);
  expect(md).toContain(`${build.site}/design/library.json`);
  expect(md).toContain(`${build.site}/schemas/design-library.json`);
  expect(md).toContain(`${build.site}/index.md`);
});

test('designLibraryLd is a Dataset whose distribution is the JSON route', () => {
  const ld = designLibraryLd(file, build) as {
    '@type': string;
    url: string;
    dateModified: string;
    distribution: { contentUrl: string; encodingFormat: string };
    isPartOf: { url: string };
  };
  expect(ld['@type']).toBe('Dataset');
  expect(ld.url).toBe(`${build.site}/design/library/`);
  expect(ld.dateModified).toBe('2026-11-10');
  expect(ld.distribution.contentUrl).toBe(`${build.site}/design/library.json`);
  expect(ld.distribution.encodingFormat).toBe('application/json');
  expect(ld.isPartOf.url).toBe(`${build.site}/`);
});
