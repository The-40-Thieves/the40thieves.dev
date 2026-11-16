import { expect, test } from 'vitest';

import {
  HUB_META_KEYS,
  HUB_SCHEMA_ID,
  changelogPostSchema,
  cloudinaryImageSchema,
  spotlightSchema,
  hubJsonSchema,
  hubJsonSchemaDocument,
  manifestSchema,
  projectEntrySchema,
  toSlug,
} from '@the40thieves/schemas';

const hub = {
  tagline: 'Universal code and logic calculator for AI models.',
  claim: {
    text: '51 MCP tools across 31 languages.',
    source: 'https://github.com/The-40-Thieves/codecalc/blob/main/README.md',
    measured_on: '2026-11-02',
  },
  install: {
    shell: 'uvx codecalc',
    'claude-code': 'claude mcp add codecalc -- uvx codecalc',
  },
  docs: 'docs/',
  listed: true,
};

test('a complete hub.json parses and listed defaults to false', () => {
  expect(hubJsonSchema.parse(hub).listed).toBe(true);
  const withoutListed: Partial<typeof hub> = structuredClone(hub);
  delete withoutListed.listed;
  expect(hubJsonSchema.parse(withoutListed).listed).toBe(false);
});

test('docs_site defaults to false and must be a boolean', () => {
  expect(hubJsonSchema.parse(hub).docs_site).toBe(false);
  expect(hubJsonSchema.parse({ ...hub, docs_site: true }).docs_site).toBe(true);
  expect(() => hubJsonSchema.parse({ ...hub, docs_site: 'yes' })).toThrow();
});

test('a placeholder claim or tagline is rejected', () => {
  for (const text of ['TODO measure this', 'placeholder claim', 'Lorem ipsum', 'tbd']) {
    expect(() => hubJsonSchema.parse({ ...hub, claim: { ...hub.claim, text } })).toThrow(
      /placeholder/i,
    );
  }
  expect(() => hubJsonSchema.parse({ ...hub, tagline: 'TBD' })).toThrow(/placeholder/i);
});

test('a claim needs an https source and an ISO date', () => {
  expect(() =>
    hubJsonSchema.parse({ ...hub, claim: { ...hub.claim, source: 'http://example.com' } }),
  ).toThrow();
  expect(() =>
    hubJsonSchema.parse({ ...hub, claim: { ...hub.claim, measured_on: '2 Nov 2026' } }),
  ).toThrow();
});

test('install needs at least one client snippet', () => {
  expect(() => hubJsonSchema.parse({ ...hub, install: {} })).toThrow(/install/);
});

test('toSlug is url-safe and stable', () => {
  expect(toSlug('codecalc')).toBe('codecalc');
  expect(toSlug('Suavecitos-Soundboost.AI-Toolkit')).toBe('suavecitos-soundboost-ai-toolkit');
  expect(toSlug('own-the-house')).toBe('own-the-house');
  expect(toSlug('  Weird__Name!! ')).toBe('weird-name');
});

test('a project entry carries the fields the pages and manifest read', () => {
  const entry = projectEntrySchema.parse({
    name: 'codecalc',
    slug: 'codecalc',
    description: 'desc',
    url: 'https://github.com/The-40-Thieves/codecalc',
    homepage: null,
    stars: 3,
    topics: ['mcp'],
    taxonomy: ['mcp'],
    license: 'Apache-2.0',
    default_branch: 'main',
    head: { sha: 'a'.repeat(40), committed_at: '2026-11-01T00:00:00Z' },
    release: null,
    readme: null,
    hub: null,
    hub_source: null,
    server: null,
    mcpb: null,
    listed: false,
    fetched_at: '2026-11-02T00:00:00Z',
  });
  expect(entry.listed).toBe(false);
  expect(() => projectEntrySchema.parse({ ...entry, head: { sha: 'short' } })).toThrow();
});

test('every manifest project and tool carries provenance', () => {
  const manifest = {
    version: 1,
    generated_at: '2026-11-02T00:00:00Z',
    commit: 'b'.repeat(40),
    site: 'https://the40thieves.dev',
    projects: [
      {
        slug: 'codecalc',
        name: 'codecalc',
        tagline: 't',
        description: null,
        listed: true,
        repo: 'https://github.com/The-40-Thieves/codecalc',
        page: '/codecalc/',
        release: null,
        install: { shell: null, 'claude-code': null, cursor: null, vscode: null },
        docs: null,
        source: { repo: 'The-40-Thieves/codecalc', path: 'hub.json', sha: 'a'.repeat(40) },
      },
    ],
    pages: ['/', '/404/', '/codecalc/'],
    changelog: [],
    mcp: { endpoint: 'https://the40thieves.dev/mcp', tools: [] },
    tools: [
      {
        name: 'calc',
        description: 'd',
        project: 'codecalc',
        read_only: null,
        input_schema: null,
        source: {
          repo: 'The-40-Thieves/codecalc',
          path: 'mcpb/manifest.json',
          sha: 'a'.repeat(40),
        },
      },
    ],
  };
  expect(manifestSchema.parse(manifest).projects[0]?.source.path).toBe('hub.json');
  const toolWithoutSource: Partial<(typeof manifest.tools)[number]> = structuredClone(
    manifest.tools[0] ?? {},
  );
  delete toolWithoutSource.source;
  expect(() => manifestSchema.parse({ ...manifest, tools: [toolWithoutSource] })).toThrow();
});

test('the published JSON Schema carries its id and allows the editor keys on top of the strict shape', () => {
  const document = hubJsonSchemaDocument();
  expect(document['$id']).toBe(HUB_SCHEMA_ID);
  expect(document['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  const properties = document['properties'] as Record<string, unknown>;
  expect(Object.keys(properties)).toEqual(
    expect.arrayContaining([
      '$schema',
      '$comment',
      'tagline',
      'claim',
      'install',
      'docs',
      'docs_site',
      'listed',
    ]),
  );
  expect(document['additionalProperties']).toBe(false);
  expect(HUB_META_KEYS).toEqual(['$schema', '$comment']);
});

test('the published hub.json schema does not require the defaulted listed field', () => {
  // The loader accepts a hub.json without `listed` and defaults it to false, so the document
  // repositories validate against must describe the input shape, not the parsed output.
  const document = hubJsonSchemaDocument();
  const required = document['required'] as string[];
  expect(required).toEqual(expect.arrayContaining(['tagline', 'claim', 'install']));
  expect(required).not.toContain('listed');
});
test('a spotlight carries the projected Sanity fields and rejects a drifted date', () => {
  const spotlight = {
    id: 'abc',
    title: 'codecalc 0.13',
    slug: 'codecalc-0-13',
    summary: 'One calculator for 31 languages.',
    body: [
      {
        _type: 'block',
        _key: 'k',
        style: 'normal',
        children: [],
        markDefs: [],
      },
    ],
    project: 'codecalc',
    link: null,
    image: null,
    published_at: '2026-11-03T09:00:00.000Z',
    updated_at: '2026-11-03T09:05:00.000Z',
  };
  expect(spotlightSchema.parse(spotlight).project).toBe('codecalc');
  expect(spotlightSchema.safeParse({ ...spotlight, published_at: '2026-11-03' }).success).toBe(
    false,
  );
  expect(spotlightSchema.safeParse({ ...spotlight, project: 'Not A Slug' }).success).toBe(false);
  expect(spotlightSchema.safeParse({ ...spotlight, extra: 1 }).success).toBe(false);
});

test('a spotlight image is a Cloudinary public id with alt text, or null', () => {
  const image = {
    public_id: 'the40thieves/codecalc-0-13',
    format: 'png',
    width: 1600,
    height: 900,
    alt: 'codecalc converting a hex literal in the terminal',
  };
  expect(cloudinaryImageSchema.parse(image).public_id).toBe('the40thieves/codecalc-0-13');
  expect(cloudinaryImageSchema.safeParse({ ...image, alt: ' ' }).success).toBe(false);
  expect(cloudinaryImageSchema.safeParse({ ...image, public_id: '../etc/passwd' }).success).toBe(
    false,
  );
  expect(cloudinaryImageSchema.safeParse({ ...image, public_id: 'a b' }).success).toBe(false);
  expect(cloudinaryImageSchema.safeParse({ ...image, secure_url: 'https://x' }).success).toBe(
    false,
  );
  const spotlight = {
    id: 'abc',
    title: 'codecalc 0.13',
    slug: 'codecalc-0-13',
    summary: 'One calculator for 31 languages.',
    body: null,
    project: null,
    link: null,
    image,
    published_at: '2026-11-03T09:00:00.000Z',
    updated_at: '2026-11-03T09:05:00.000Z',
  };
  expect(spotlightSchema.parse(spotlight).image?.alt).toBe(image.alt);
  expect(spotlightSchema.parse({ ...spotlight, image: null }).image).toBeNull();
});

test('a changelog post has no link field and requires a summary', () => {
  const post = {
    id: 'def',
    title: 'Cards',
    slug: 'cards',
    summary: 'SVG cards per project.',
    body: null,
    project: null,
    published_at: '2026-11-04T08:00:00.000Z',
    updated_at: '2026-11-04T08:00:00.000Z',
  };
  expect(changelogPostSchema.parse(post).body).toBeNull();
  expect(changelogPostSchema.safeParse({ ...post, link: null }).success).toBe(false);
  expect(changelogPostSchema.safeParse({ ...post, summary: ' ' }).success).toBe(false);
});
test('a spotlight link must be http(s); javascript: and data: URLs are rejected', () => {
  const spotlight = {
    id: 'abc',
    title: 'Link check',
    slug: 'link-check',
    summary: 'Scheme allowlist.',
    body: null,
    project: null,
    link: 'https://example.com/x',
    image: null,
    published_at: '2026-11-03T09:00:00.000Z',
    updated_at: '2026-11-03T09:05:00.000Z',
  };
  expect(spotlightSchema.parse(spotlight).link).toBe('https://example.com/x');
  for (const link of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x']) {
    expect(spotlightSchema.safeParse({ ...spotlight, link }).success).toBe(false);
  }
});
