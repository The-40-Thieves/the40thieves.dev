import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { manifestSchema } from '@the40thieves/schemas';
import {
  buildManifest,
  checkSurfaces,
  HUB_MCP_TOOLS,
  jsonLdBlocks,
  llmsProjects,
  manifestJsonSchema,
  MAX_RELEASE_NOTES_BYTES,
  MCP_TOOL_NAMES,
  projectLinks,
  twinPath,
  type BuildInfo,
} from '@the40thieves/manifest';
import { expect, test } from 'vitest';

import { readHubOverrides, toEntries, type OrganizationResponse } from '../src/loaders/github.ts';
import { readFixture, toEntries as sanityEntries } from '../src/loaders/sanity.ts';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/github-org.json'), 'utf8'),
) as OrganizationResponse;
const entries = toEntries(
  fixture,
  readHubOverrides(resolve(import.meta.dirname, '../content/hub')),
  '2026-11-02T20:00:00.000Z',
);
const build: BuildInfo = {
  generatedAt: '2026-11-02T21:00:00.000Z',
  commit: 'c'.repeat(40),
  site: 'https://the40thieves.dev',
};
const posts = sanityEntries(
  'changelogPost',
  readFixture(resolve(import.meta.dirname, 'fixtures/sanity.json'), 'changelogPost'),
);

test('the manifest lists every repo, pages for the listed ones, and provenance everywhere', () => {
  const manifest = buildManifest(entries, build);
  expect(manifest.projects).toHaveLength(9);
  expect(manifest.pages).toEqual([
    '/',
    '/404/',
    '/alexandria-mcp/',
    '/alexandria/sources/',
    '/alexandria/try/',
    '/audio-forge/',
    '/changelog/',
    '/codecalc/',
    '/design/library/',
  ]);
  const codecalc = manifest.projects.find((p) => p.slug === 'codecalc');
  expect(codecalc?.page).toBe('/codecalc/');
  expect(codecalc?.docs).toBe('https://the40thieves.dev/codecalc/docs/');
  expect(codecalc?.source).toEqual({
    repo: 'The-40-Thieves/the40thieves.dev',
    path: 'apps/hub/content/hub/codecalc.json',
    sha: build.commit,
  });
  const unlisted = manifest.projects.find((p) => p.slug === 'own-the-house');
  expect(unlisted?.page).toBeNull();
  expect(unlisted?.docs).toBeNull();
  expect(unlisted?.source.path).toBe('README.md');
  for (const tool of manifest.tools) {
    expect(tool.source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(tool.project).toBeTruthy();
  }
  expect(manifestSchema.parse(manifest)).toEqual(manifest);
});

test('the manifest is deterministic for the same entries and build', () => {
  expect(buildManifest(entries, build)).toEqual(buildManifest([...entries].reverse(), build));
});

test('the committed JSON Schema matches the zod schema', () => {
  const committed = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../packages/manifest/manifest.schema.json'),
      'utf8',
    ),
  ) as unknown;
  expect(committed).toEqual(manifestJsonSchema());
});

test('projectLinks keeps only root-level project-shaped links', () => {
  const html =
    '<a href="/codecalc/">a</a> <a href="/codecalc">b</a> <a href="/codecalc/docs/">c</a> ' +
    '<a href="https://github.com/x">d</a> <a href="/">e</a> <a href="/404/?x=1">f</a>';
  expect(projectLinks(html)).toEqual(['/404/', '/codecalc/']);
});

test('llmsProjects reads the list items', () => {
  expect(llmsProjects('# T\n\n- [codecalc](https://x)\n- [audio-forge](https://y)\ntext')).toEqual([
    'audio-forge',
    'codecalc',
  ]);
});

test('a page linking to a project outside the manifest is a violation', () => {
  const manifest = buildManifest(entries, build);
  const pages = new Map([
    ['/', '<a href="/codecalc/">ok</a> <a href="/ghost/">no</a>'],
    ['/404/', ''],
  ]);
  const violations = checkSurfaces(manifest, { pages, llmsTxt: null });
  expect(violations).toEqual([
    { surface: 'pages', where: '/', detail: 'links to /ghost/, which is not in manifest.pages' },
  ]);
});

test('a page that is not in the manifest and an unknown llms.txt project are violations', () => {
  const manifest = buildManifest(entries, build);
  const violations = checkSurfaces(manifest, {
    pages: new Map([['/secret/', '']]),
    llmsTxt: '- [codecalc](https://a)\n- [phantom](https://b)\n',
  });
  expect(violations.map((v) => v.detail)).toEqual([
    'page is not in manifest.pages',
    'names phantom, which is not a manifest project',
  ]);
});
test('each manifest project carries its install snippet per client, or null (P3-S1)', () => {
  const manifest = buildManifest(entries, build);
  const codecalc = manifest.projects.find((p) => p.slug === 'codecalc');
  expect(codecalc?.install).toEqual({
    shell: "uvx 'codecalc[full]' setup --write",
    'claude-code': "claude mcp add codecalc -- uvx 'codecalc[full]'",
    cursor: '{ "mcpServers": { "codecalc": { "command": "uvx", "args": ["codecalc[full]"] } } }',
    vscode: '{ "servers": { "codecalc": { "command": "uvx", "args": ["codecalc[full]"] } } }',
  });
  expect(codecalc?.description).toEqual(expect.any(String));
  expect(manifest.projects.find((p) => p.slug === 'own-the-house')?.install).toEqual({
    shell: null,
    'claude-code': null,
    cursor: null,
    vscode: null,
  });
});

test('release notes ride along, cut at the byte cap and marked truncated (P3-S1)', () => {
  const base = entries.find((e) => e.slug === 'codecalc');
  if (!base?.release) throw new Error('the codecalc fixture needs a release');
  const long = { ...base, release: { ...base.release, body: 'é'.repeat(10_000) } };
  const manifest = buildManifest([long], build);
  const release = manifest.projects[0]?.release;
  expect(release?.notes).toMatch(/^é+$/);
  expect(new TextEncoder().encode(release?.notes ?? '').length).toBeLessThanOrEqual(
    MAX_RELEASE_NOTES_BYTES,
  );
  expect(release?.notes_truncated).toBe(true);
  const short = buildManifest(entries, build).projects.find((p) => p.slug === 'codecalc');
  expect(short?.release?.notes_truncated).toBe(false);
  expect(
    buildManifest(entries, build).projects.find((p) => p.slug === 'own-the-house')?.release,
  ).toBeNull();
});

test('the changelog lists every post newest first, pointing at the changelog page (P3-S1)', () => {
  const manifest = buildManifest(entries, build, posts);
  expect(manifest.changelog.map((post) => post.slug)).toEqual(
    [...posts]
      .sort((a, b) => b.published_at.localeCompare(a.published_at))
      .map((post) => post.slug),
  );
  for (const post of manifest.changelog) {
    expect(post.url).toBe('https://the40thieves.dev/changelog/');
    expect(Object.keys(post).sort()).toEqual(
      ['slug', 'title', 'summary', 'project', 'published_at', 'url'].sort(),
    );
    expect(typeof post.title).toBe('string');
    expect(typeof post.summary).toBe('string');
    expect(typeof post.published_at).toBe('string');
  }
  expect(buildManifest(entries, build).changelog).toEqual([]);
});

test('the mcp surface fails on a served tool outside the manifest and on an unserved manifest tool (P3-S1)', () => {
  const manifest = buildManifest(entries, build);
  const inputs = { pages: new Map<string, string>(), llmsTxt: null };
  expect(checkSurfaces(manifest, { ...inputs, mcpTools: [...MCP_TOOL_NAMES] })).toEqual([]);
  expect(checkSurfaces(manifest, { ...inputs })).toEqual([]);
  expect(
    checkSurfaces(manifest, { ...inputs, mcpTools: [...MCP_TOOL_NAMES, 'drop_tables'] }),
  ).toEqual([
    { surface: 'mcp', where: 'drop_tables', detail: 'served tool is not in manifest.mcp.tools' },
  ]);
  expect(
    checkSurfaces(manifest, {
      ...inputs,
      mcpTools: MCP_TOOL_NAMES.filter((name) => name !== 'read_doc'),
    }),
  ).toEqual([{ surface: 'mcp', where: 'read_doc', detail: 'manifest tool is not served' }]);
});

test('the manifest names the /mcp endpoint and exactly the nine hub tools (P3-S1)', () => {
  const manifest = buildManifest(entries, build);
  expect(manifest.mcp.endpoint).toBe('https://the40thieves.dev/mcp');
  expect(manifest.mcp.tools).toEqual(HUB_MCP_TOOLS);
  expect(manifest.mcp.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
  expect(MCP_TOOL_NAMES).toEqual([
    'search_projects',
    'compare_projects',
    'get_project',
    'get_install',
    'latest_release',
    'changelog_since',
    'search_docs',
    'read_doc',
    'validate_config',
  ]);
  for (const tool of manifest.mcp.tools) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.read_only).toBe(true);
  }
});

test('an emitted card for a project outside the manifest, or an unlisted one, is a violation', () => {
  const manifest = buildManifest(entries, build);
  const inputs = { pages: new Map<string, string>(), llmsTxt: null };
  expect(
    checkSurfaces(manifest, {
      ...inputs,
      cards: ['/og/banner.svg', '/og/card/codecalc.svg', '/og/card/audio-forge.svg'],
    }),
  ).toEqual([]);
  expect(
    checkSurfaces(manifest, {
      ...inputs,
      cards: ['/og/card/own-the-house.svg'],
    }),
  ).toEqual([
    {
      surface: 'cards',
      where: '/og/card/own-the-house.svg',
      detail: 'own-the-house has no page in the manifest',
    },
  ]);
  expect(checkSurfaces(manifest, { ...inputs, cards: ['/og/card/nope.svg'] })).toEqual([
    {
      surface: 'cards',
      where: '/og/card/nope.svg',
      detail: 'nope is not a manifest project',
    },
  ]);
  expect(checkSurfaces(manifest, { ...inputs, cards: ['/og/other.svg'] })).toEqual([
    {
      surface: 'cards',
      where: '/og/other.svg',
      detail: 'not a banner or a project card path',
    },
  ]);
});

test('twinPath maps every page to its Markdown twin (P3-S2)', () => {
  expect(twinPath('/')).toBe('/index.md');
  expect(twinPath('/codecalc/')).toBe('/codecalc.md');
  expect(twinPath('/404/')).toBe('/404.md');
  expect(twinPath('/codecalc/docs/')).toBe('/codecalc/docs.md');
});

test('jsonLdBlocks parses every ld+json script and rejects a malformed one', () => {
  const html =
    '<script type="application/ld+json">{"@type":"WebSite"}</script>' +
    '<script>1</script><script type="application/ld+json">[{"@type":"Thing"}]</script>';
  expect(jsonLdBlocks(html)).toEqual([{ '@type': 'WebSite' }, [{ '@type': 'Thing' }]]);
  expect(jsonLdBlocks('<p>none</p>')).toEqual([]);
  expect(() => jsonLdBlocks('<script type="application/ld+json">nope</script>')).toThrow(/JSON-LD/);
});

test('a page without a twin, a twin outside the manifest, and a twin linking elsewhere are violations', () => {
  const manifest = buildManifest(entries, build);
  const twins = new Map<string, string>();
  for (const page of manifest.pages) twins.set(twinPath(page), `# ${page}`);
  const inputs = { pages: new Map<string, string>(), llmsTxt: null };
  expect(checkSurfaces(manifest, { ...inputs, twins })).toEqual([]);
  twins.delete('/audio-forge.md');
  twins.set(
    '/codecalc.md',
    '[x](/ghost/) [y](https://the40thieves.dev/phantom/) [ok](/changelog/)',
  );
  twins.set('/secret.md', '# secret');
  expect(checkSurfaces(manifest, { ...inputs, twins })).toEqual([
    { surface: 'twins', where: '/audio-forge/', detail: 'page has no twin at /audio-forge.md' },
    {
      surface: 'twins',
      where: '/codecalc.md',
      detail: 'links to /ghost/, which is not in manifest.pages',
    },
    {
      surface: 'twins',
      where: '/codecalc.md',
      detail: 'links to /phantom/, which is not in manifest.pages',
    },
    { surface: 'twins', where: '/secret.md', detail: 'twin is not for a manifest page' },
  ]);
});

test('a page without JSON-LD, or JSON-LD naming something outside the manifest, is a violation', () => {
  const manifest = buildManifest(entries, build);
  const inputs = { pages: new Map<string, string>(), llmsTxt: null };
  const good = new Map<string, unknown[]>([
    [
      '/',
      [
        {
          '@type': 'WebSite',
          url: 'https://the40thieves.dev/',
          hasPart: [
            {
              '@type': 'SoftwareSourceCode',
              name: 'codecalc',
              url: 'https://the40thieves.dev/codecalc/',
            },
          ],
        },
      ],
    ],
    [
      '/changelog/',
      [
        {
          '@type': 'Blog',
          url: 'https://the40thieves.dev/changelog/',
          blogPost: [{ url: 'https://the40thieves.dev/changelog/#x' }],
        },
      ],
    ],
  ]);
  expect(checkSurfaces(manifest, { ...inputs, jsonLd: good })).toEqual([]);
  const bad = new Map<string, unknown[]>([
    ['/', []],
    [
      '/codecalc/',
      [{ '@type': 'SoftwareSourceCode', name: 'phantom', url: 'https://the40thieves.dev/ghost/' }],
    ],
    [
      '/404/',
      [
        {
          '@type': 'SoftwareSourceCode',
          name: 'own-the-house',
          url: 'https://the40thieves.dev/404/',
        },
      ],
    ],
  ]);
  expect(checkSurfaces(manifest, { ...inputs, jsonLd: bad })).toEqual([
    { surface: 'json-ld', where: '/', detail: 'page carries no JSON-LD' },
    {
      surface: 'json-ld',
      where: '/codecalc/',
      detail: 'names phantom, which is not a manifest project',
    },
    {
      surface: 'json-ld',
      where: '/codecalc/',
      detail: 'links to /ghost/, which is not in manifest.pages',
    },
    {
      surface: 'json-ld',
      where: '/404/',
      detail: 'names own-the-house, which has no page in the manifest',
    },
  ]);
});
