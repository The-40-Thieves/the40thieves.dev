import { MCP_TOOL_NAMES } from '@the40thieves/manifest';
import type { Manifest } from '@the40thieves/schemas';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import type { Client } from '@modelcontextprotocol/client';

import { MAX_PAGE_BYTES } from '../src/caps.ts';
import { resetDataCache } from '../src/data.ts';
import { call, connectV2, text } from './client.ts';
import { fixture } from './fake-kv.ts';

const manifest = JSON.parse(fixture('manifest.json')) as Manifest;
const docsFixture = JSON.parse(fixture('docs-index.json')) as {
  documents: { path: string; text: string }[];
};

let client: Client;

beforeAll(async () => {
  resetDataCache();
  client = await connectV2();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  resetDataCache();
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test('tools/list is exactly the manifest tool list, every tool read-only with an output schema', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    expect(tool.outputSchema, tool.name).toBeDefined();
    expect(tool.description, tool.name).toBe(
      manifest.mcp.tools.find((entry) => entry.name === tool.name)?.description,
    );
  }
});

test('search_projects ranks name hits over tagline hits and lists only listed projects', async () => {
  const reply = await call(client, 'search_projects', { query: 'calculator' });
  expect(reply.isError).toBeFalsy();
  const { results, next_cursor } = reply.structuredContent as {
    results: { slug: string; score: number; page: string }[];
    next_cursor: string | null;
  };
  expect(results[0]?.slug).toBe('codecalc');
  expect(results[0]?.score).toBeGreaterThan(0);
  expect(next_cursor).toBeNull();
  const byName = await call(client, 'search_projects', { query: 'CodeCalc alexandria' });
  const names = (byName.structuredContent as { results: { slug: string }[] }).results.map(
    (r) => r.slug,
  );
  expect(names.slice(0, 2).sort()).toEqual(['alexandria-mcp', 'codecalc']);
  const unlisted = await call(client, 'search_projects', { query: 'obsidian' });
  expect((unlisted.structuredContent as { results: unknown[] }).results).toEqual([]);
});

// The SDK answers arguments outside the input schema with an isError result naming the field.
test('search_projects rejects an empty query and a limit over 20', async () => {
  const empty = await call(client, 'search_projects', { query: '' });
  expect(empty.isError).toBe(true);
  expect(text(empty)).toMatch(/Input validation error.*query/);
  const over = await call(client, 'search_projects', { query: 'x', limit: 21 });
  expect(over.isError).toBe(true);
  expect(text(over)).toMatch(/Input validation error.*limit/);
});

test('get_project returns the manifest project with release notes marked untrusted', async () => {
  const reply = await call(client, 'get_project', { slug: 'codecalc' });
  expect(reply.isError).toBeFalsy();
  const project = reply.structuredContent as {
    slug: string;
    install: Record<string, string | null>;
    release: { tag: string; notes: { text: string | null; untrusted: true; truncated: boolean } };
    source: { sha: string };
  };
  expect(project.slug).toBe('codecalc');
  expect(Object.keys(project.install).sort()).toEqual(['claude-code', 'cursor', 'shell', 'vscode']);
  expect(project.release.tag).toBe('v0.13.0');
  expect(project.release.notes.untrusted).toBe(true);
  expect(typeof project.release.notes.truncated).toBe('boolean');
  expect(project.source.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(bytes(project)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
});

test('get_project on an unknown slug is a tool error, not a throw', async () => {
  const reply = await call(client, 'get_project', { slug: 'nope' });
  expect(reply.isError).toBe(true);
  expect(text(reply)).toMatch(/nope/);
});

test('compare_projects lines up two to five projects', async () => {
  const reply = await call(client, 'compare_projects', { slugs: ['codecalc', 'alexandria-mcp'] });
  expect(reply.isError).toBeFalsy();
  const { projects } = reply.structuredContent as {
    projects: {
      slug: string;
      release: { tag: string; published_at: string } | null;
      install: { shell: string | null };
      docs: string | null;
    }[];
  };
  expect(projects.map((p) => p.slug)).toEqual(['codecalc', 'alexandria-mcp']);
  expect(projects[0]?.release?.tag).toBe('v0.13.0');
  expect(projects[0]?.install.shell).toContain('uvx');
  const unknown = await call(client, 'compare_projects', { slugs: ['codecalc', 'nope'] });
  expect(unknown.isError).toBe(true);
  expect(text(unknown)).toMatch(/nope/);
  const one = await call(client, 'compare_projects', { slugs: ['codecalc'] });
  expect(one.isError).toBe(true);
  expect(text(one)).toMatch(/Input validation error.*slugs/);
});

test('get_install returns the snippet and its format, or an error when none is published', async () => {
  const cursor = await call(client, 'get_install', { slug: 'codecalc', client: 'cursor' });
  expect(cursor.structuredContent).toMatchObject({
    slug: 'codecalc',
    client: 'cursor',
    format: 'json',
  });
  const snippet = (cursor.structuredContent as { snippet: string }).snippet;
  expect(JSON.parse(snippet)).toEqual({
    mcpServers: { codecalc: { command: 'uvx', args: ['codecalc[full]'] } },
  });
  const shell = await call(client, 'get_install', { slug: 'codecalc', client: 'claude-code' });
  expect(shell.structuredContent).toMatchObject({ format: 'shell' });
  const missing = await call(client, 'get_install', { slug: 'audio-forge', client: 'cursor' });
  expect(missing.isError).toBe(true);
  expect(text(missing)).toMatch(/audio-forge/);
  const emacs = await call(client, 'get_install', { slug: 'codecalc', client: 'emacs' });
  expect(emacs.isError).toBe(true);
  expect(text(emacs)).toMatch(/Input validation error.*client/);
});

test('latest_release carries the notes as untrusted text, and errors without a release', async () => {
  const reply = await call(client, 'latest_release', { slug: 'codecalc' });
  expect(reply.structuredContent).toMatchObject({
    slug: 'codecalc',
    tag: 'v0.13.0',
    notes: { untrusted: true },
  });
  const release = reply.structuredContent as { published_at: string; url: string };
  expect(release.url).toMatch(/^https:\/\/github\.com\//);
  expect(release.published_at).toMatch(/^\d{4}-/);
  const none = await call(client, 'latest_release', { slug: 'audio-forge' });
  expect(none.isError).toBe(true);
});

test('changelog_since filters releases by semver and posts by date', async () => {
  const all = await call(client, 'changelog_since', {});
  const everything = all.structuredContent as {
    releases: { slug: string; tag: string }[];
    posts: { slug: string; project: string | null }[];
    history: string;
  };
  expect(everything.history).toBe('latest-only');
  expect(everything.releases.map((r) => r.slug)).toEqual(
    manifest.projects.filter((p) => p.release !== null).map((p) => p.slug),
  );
  expect(everything.posts).toHaveLength(manifest.changelog.length);

  const newer = await call(client, 'changelog_since', { version: '0.9.0' });
  const tags = (newer.structuredContent as { releases: { slug: string; tag: string }[] }).releases;
  expect(tags.map((r) => r.slug)).toContain('codecalc'); // v0.13.0 > 0.9.0 by semver, not by string
  expect(tags.map((r) => r.slug)).toContain('alexandria-mcp');

  const prerelease = await call(client, 'changelog_since', {
    slug: 'codecalc',
    version: 'v0.13.0-rc.1',
  });
  expect((prerelease.structuredContent as { releases: unknown[] }).releases).toHaveLength(1);
  const same = await call(client, 'changelog_since', { slug: 'codecalc', version: 'v0.13.0' });
  expect((same.structuredContent as { releases: unknown[] }).releases).toHaveLength(0);

  const scoped = await call(client, 'changelog_since', { slug: 'codecalc' });
  const posts = (scoped.structuredContent as { posts: { project: string | null }[] }).posts;
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every((p) => p.project === 'codecalc')).toBe(true);

  const future = await call(client, 'changelog_since', { since: '2999-01-01' });
  expect((future.structuredContent as { posts: unknown[] }).posts).toEqual([]);
});

test('changelog_since rejects a version that is not semver and a date that is not ISO', async () => {
  const bad = await call(client, 'changelog_since', { version: 'banana' });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toMatch(/banana/);
  const badDate = await call(client, 'changelog_since', { since: 'yesterday' });
  expect(badDate.isError).toBe(true);
  const unknown = await call(client, 'changelog_since', { slug: 'nope' });
  expect(unknown.isError).toBe(true);
});

test('search_docs finds the twin by its words and marks the results untrusted', async () => {
  const reply = await call(client, 'search_docs', { query: 'calculator sandbox' });
  const { results, untrusted } = reply.structuredContent as {
    results: { path: string; title: string; snippet: string; score: number }[];
    untrusted: boolean;
  };
  expect(untrusted).toBe(true);
  expect(results[0]?.path).toBe('/codecalc.md');
  expect(results[0]?.title).toBe('CodeCalc');
  expect(results[0]?.snippet.toLowerCase()).toContain('calculator');
  expect(results[0]?.score).toBeGreaterThan(0);
  const nothing = await call(client, 'search_docs', { query: 'zzzzqqqq' });
  expect((nothing.structuredContent as { results: unknown[] }).results).toEqual([]);
});

test('read_doc pages a long document at 20 kB and the pages concatenate to the whole text', async () => {
  const whole = docsFixture.documents.find((d) => d.path === '/codecalc.md')?.text ?? '';
  expect(new TextEncoder().encode(whole).length).toBeGreaterThan(MAX_PAGE_BYTES);
  let cursor: string | undefined;
  let out = '';
  let pages = 0;
  do {
    const reply = await call(client, 'read_doc', {
      path: '/codecalc.md',
      ...(cursor ? { cursor } : {}),
    });
    expect(reply.isError).toBeFalsy();
    const body = reply.structuredContent as {
      path: string;
      title: string;
      text: string;
      untrusted: true;
      next_cursor: string | null;
    };
    expect(body.path).toBe('/codecalc.md');
    expect(body.title).toBe('CodeCalc');
    expect(body.untrusted).toBe(true);
    expect(bytes(body)).toBeLessThanOrEqual(MAX_PAGE_BYTES + 512);
    out += body.text;
    cursor = body.next_cursor ?? undefined;
    pages++;
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(out).toBe(whole);
});

test('read_doc outside the index answers "not in the index" without touching the path', async () => {
  for (const path of ['/etc/passwd', '../index.md', '/codecalc', 'codecalc.md', '/nope.md']) {
    const reply = await call(client, 'read_doc', { path });
    expect(reply.isError, path).toBe(true);
    expect(text(reply), path).toContain('not in the index');
  }
});

test('read_doc with a cursor the server did not issue is a tool error with a message', async () => {
  const reply = await call(client, 'read_doc', { path: '/codecalc.md', cursor: 'zzz' });
  expect(reply.isError).toBe(true);
  expect(text(reply)).toMatch(/cursor/i);
});

test('validate_config compares a client config against the published snippet', async () => {
  const ok = await call(client, 'validate_config', {
    slug: 'codecalc',
    client: 'cursor',
    config: '{ "mcpServers": { "codecalc": { "command": "uvx", "args": ["codecalc[full]"] } } }',
  });
  expect(ok.structuredContent).toMatchObject({ valid: true, issues: [] });
  const wrong = await call(client, 'validate_config', {
    slug: 'codecalc',
    client: 'cursor',
    config: { mcpServers: { codecalc: { command: 'npx', args: ['codecalc[full]'] } } },
  });
  expect(wrong.structuredContent).toMatchObject({
    valid: false,
    issues: [{ path: 'mcpServers.codecalc.command' }],
  });
  const other = await call(client, 'validate_config', {
    slug: 'codecalc',
    client: 'vscode',
    config: {
      servers: { alexandria: { command: 'npx', args: ['-y', '@the-40-thieves/alexandria-mcp'] } },
    },
  });
  expect((other.structuredContent as { valid: boolean }).valid).toBe(false);
  const unknown = await call(client, 'validate_config', {
    slug: 'nope',
    client: 'cursor',
    config: {},
  });
  expect(unknown.isError).toBe(true);
});
