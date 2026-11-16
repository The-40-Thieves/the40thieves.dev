import type { Manifest } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import {
  bodyOf,
  readmeChanged,
  renderOrgReadme,
  type CardHashes,
} from '../scripts/render-org-readme.ts';

const source = { repo: 'The-40-Thieves/the40thieves.dev', path: 'x', sha: 'c'.repeat(40) };

const manifest: Manifest = {
  version: 1,
  generated_at: '2026-11-04T09:27:36.201Z',
  commit: '46fb607981efe5f0114f429c1820f81900b179d0',
  site: 'https://the40thieves.dev',
  projects: [
    {
      slug: 'codecalc',
      name: 'codecalc',
      tagline: 'A calculator for agents: 51 tools | sandboxed.',
      description: null,
      listed: true,
      repo: 'https://github.com/The-40-Thieves/codecalc',
      page: '/codecalc/',
      release: {
        tag: 'v0.13.0',
        published_at: '2026-09-21T23:44:00Z',
        url: 'https://github.com/The-40-Thieves/codecalc/releases/tag/v0.13.0',
        notes: null,
        notes_truncated: false,
      },
      install: {
        shell: "uvx 'codecalc[full]' setup --write",
        'claude-code': null,
        cursor: null,
        vscode: null,
      },
      docs: 'https://the40thieves.dev/codecalc/docs/',
      source,
    },
    {
      slug: 'audio-forge',
      name: 'audio-forge',
      tagline: 'An audio delivery pipeline AI agents can drive.',
      description: null,
      listed: true,
      repo: 'https://github.com/The-40-Thieves/audio-forge',
      page: '/audio-forge/',
      release: null,
      install: { shell: null, 'claude-code': null, cursor: null, vscode: null },
      docs: null,
      source,
    },
    {
      slug: 'own-the-house',
      name: 'own-the-house',
      tagline: 'own-the-house',
      description: null,
      listed: false,
      repo: 'https://github.com/The-40-Thieves/own-the-house',
      page: null,
      release: null,
      install: { shell: null, 'claude-code': null, cursor: null, vscode: null },
      docs: null,
      source,
    },
  ],
  pages: ['/', '/404/', '/audio-forge/', '/codecalc/'],
  tools: [],
  changelog: [],
  mcp: { endpoint: 'https://the40thieves.dev/mcp', tools: [] },
};

const hashes: CardHashes = {
  banner: 'aaaa1111',
  cards: { codecalc: 'bbbb2222', 'audio-forge': 'cccc3333' },
};

test('renders Markdown only: banner, a linked card per listed project, the table and the links', () => {
  const md = renderOrgReadme(manifest, hashes, '2026-11-04T10:00:00.000Z');
  expect(md).not.toMatch(/<[a-z]/i);
  expect(md).toContain(
    '[![The 40 Thieves. Tools first.](https://the40thieves.dev/og/banner.svg?v=aaaa1111)](https://the40thieves.dev)',
  );
  expect(md).toContain(
    '[![codecalc](https://the40thieves.dev/og/card/codecalc.svg?v=bbbb2222)](https://the40thieves.dev/codecalc/)',
  );
  expect(md).toContain(
    '[![audio-forge](https://the40thieves.dev/og/card/audio-forge.svg?v=cccc3333)](https://the40thieves.dev/audio-forge/)',
  );
  expect(md).not.toContain('own-the-house.svg');
  expect(md).toContain('| Project | What it is | Latest release | Install |');
  expect(md).toContain(
    "| [codecalc](https://the40thieves.dev/codecalc/) | A calculator for agents: 51 tools \\| sandboxed. | [v0.13.0](https://github.com/The-40-Thieves/codecalc/releases/tag/v0.13.0) 2026-09-21 | `uvx 'codecalc[full]' setup --write` |",
  );
  expect(md).toContain(
    '| [audio-forge](https://the40thieves.dev/audio-forge/) | An audio delivery pipeline AI agents can drive. | none yet | see the project page |',
  );
  expect(md).toContain('[own-the-house](https://github.com/The-40-Thieves/own-the-house)');
  expect(md).toContain('https://the40thieves.dev/manifest.json');
  expect(md).toContain('https://the40thieves.dev/releases.xml');
  expect(md).toContain('[CONTRIBUTING](../CONTRIBUTING.md)');
  expect(md).toContain('[SECURITY](../SECURITY.md)');
  expect(md.endsWith('\n')).toBe(true);
  expect(md).not.toContain('—');
});

test('the tools column appears only once the manifest lists tools', () => {
  const without = renderOrgReadme(manifest, hashes, '2026-11-04T10:00:00.000Z');
  expect(without).not.toContain('| Tools |');
  const withTools = renderOrgReadme(
    {
      ...manifest,
      tools: [
        {
          name: 'calc',
          description: '',
          project: 'codecalc',
          read_only: null,
          input_schema: null,
          source,
        },
        {
          name: 'run',
          description: '',
          project: 'codecalc',
          read_only: null,
          input_schema: null,
          source,
        },
      ],
    },
    hashes,
    '2026-11-04T10:00:00.000Z',
  );
  expect(withTools).toContain('| Project | What it is | Latest release | Tools | Install |');
  expect(withTools).toContain('| 2 |');
  expect(withTools).toContain('| 0 |');
});

test('the trailer names the hub commit and the time, and bodyOf strips it', () => {
  const md = renderOrgReadme(manifest, hashes, '2026-11-04T10:00:00.000Z');
  expect(md).toContain('Last updated 2026-11-04 from the40thieves.dev at commit 46fb607.');
  expect(bodyOf(md)).not.toContain('Last updated');
  expect(bodyOf(md)).toBe(bodyOf(renderOrgReadme(manifest, hashes, '2026-12-25T00:00:00.000Z')));
});

test('readmeChanged ignores the trailer and CRLF, so an unchanged manifest commits nothing', () => {
  const a = renderOrgReadme(manifest, hashes, '2026-11-04T10:00:00.000Z');
  const b = renderOrgReadme(manifest, hashes, '2026-11-05T10:00:00.000Z');
  expect(readmeChanged(a, b)).toBe(false);
  expect(readmeChanged(a, b.replaceAll('\n', '\r\n'))).toBe(false);
  expect(readmeChanged(a, null)).toBe(true);
  const moved = renderOrgReadme(
    manifest,
    { ...hashes, banner: 'ffff0000' },
    '2026-11-04T10:00:00.000Z',
  );
  expect(readmeChanged(a, moved)).toBe(true);
});

test('a hash is required for every listed project card', () => {
  expect(() =>
    renderOrgReadme(
      manifest,
      { banner: 'aaaa1111', cards: { codecalc: 'bbbb2222' } },
      '2026-11-04T10:00:00.000Z',
    ),
  ).toThrow(/audio-forge/);
});
test('a pipe in the install command is escaped so the table survives', () => {
  const piped: Manifest = {
    ...manifest,
    projects: manifest.projects.map((project) =>
      project.slug === 'codecalc'
        ? { ...project, install: { ...project.install, shell: 'curl -s x | sh' } }
        : project,
    ),
  };
  const md = renderOrgReadme(piped, hashes, '2026-11-04T10:00:00.000Z');
  expect(md).toContain('| `curl -s x \\| sh` |');
  expect(md).not.toContain('| `curl -s x | sh` |');
});

test('the trailer is still recognised when the build ran outside git', () => {
  const noCommit = renderOrgReadme(
    { ...manifest, commit: null },
    hashes,
    '2026-11-04T10:00:00.000Z',
  );
  const nextDay = renderOrgReadme(
    { ...manifest, commit: null },
    hashes,
    '2026-11-05T10:00:00.000Z',
  );
  expect(noCommit).toContain('at commit unknown.');
  expect(bodyOf(noCommit)).not.toContain('Last updated');
  expect(readmeChanged(noCommit, nextDay)).toBe(false);
});
