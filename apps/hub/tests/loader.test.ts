import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  HUB_EXCLUDE_TOPIC,
  fetchOrganization,
  readHubOverrides,
  toEntries,
  type OrganizationResponse,
} from '../src/loaders/github.ts';

const fixturePath = resolve(import.meta.dirname, 'fixtures/github-org.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as OrganizationResponse;
const overridesDir = resolve(import.meta.dirname, '../content/hub');
const fetchedAt = '2026-11-02T20:00:00.000Z';

const clone = () => structuredClone(fixture);

test('the recorded org yields one entry per public repo, three listed via hub-side hub.json', () => {
  const entries = toEntries(clone(), readHubOverrides(overridesDir), fetchedAt);
  expect(entries).toHaveLength(9);
  const listed = entries.filter((entry) => entry.listed).map((entry) => entry.slug);
  expect(listed).toEqual(['alexandria-mcp', 'audio-forge', 'codecalc']);
  const codecalc = entries.find((entry) => entry.slug === 'codecalc');
  expect(codecalc?.hub_source).toBe('hub');
  expect(codecalc?.release?.tag).toBe('v0.13.0');
  expect(codecalc?.mcpb).not.toBeNull();
  expect(codecalc?.head.sha).toMatch(/^[0-9a-f]{40}$/);
});

test('slugs are url-safe and the taxonomy drops hub control topics', () => {
  const entries = toEntries(clone(), new Map(), fetchedAt);
  expect(entries.map((entry) => entry.slug)).toContain('suavecitos-soundboost-ai-toolkit');
  const own = entries.find((entry) => entry.slug === 'own-the-house');
  expect(own?.taxonomy).toEqual(own?.topics);
  expect(entries.every((entry) => !entry.listed)).toBe(true);
});

test('a repo topic hub-exclude drops the repo entirely', () => {
  const raw = clone();
  const nodes = raw.data.organization.repositories.nodes;
  const target = nodes.find((node) => node.name === 'homebrew-tap');
  target?.repositoryTopics.nodes.push({ topic: { name: HUB_EXCLUDE_TOPIC } });
  const entries = toEntries(raw, new Map(), fetchedAt);
  expect(entries.map((entry) => entry.name)).not.toContain('homebrew-tap');
  expect(entries).toHaveLength(8);
});

test('a hub.json in the repo wins over the hub-side file', () => {
  const raw = clone();
  const codecalc = raw.data.organization.repositories.nodes.find(
    (node) => node.name === 'codecalc',
  );
  const repoHub = {
    tagline: 'From the repo.',
    claim: {
      text: 'Fifty-one tools.',
      source: 'https://github.com/The-40-Thieves/codecalc',
      measured_on: '2026-11-01',
    },
    install: { shell: 'uvx codecalc' },
    listed: false,
  };
  if (codecalc) codecalc.hub = { text: JSON.stringify(repoHub) };
  const entry = toEntries(raw, readHubOverrides(overridesDir), fetchedAt).find(
    (candidate) => candidate.slug === 'codecalc',
  );
  expect(entry?.hub_source).toBe('repo');
  expect(entry?.hub?.tagline).toBe('From the repo.');
  expect(entry?.listed).toBe(false);
});

test('a repo hub.json may carry $schema and $comment; the loader drops them before the strict parse', () => {
  const raw = clone();
  const codecalc = raw.data.organization.repositories.nodes.find(
    (node) => node.name === 'codecalc',
  );
  const repoHub = {
    $schema: 'https://the40thieves.dev/schemas/hub.json',
    $comment: 'kept for maintainers',
    tagline: 'From the repo, with a schema pointer.',
    claim: {
      text: 'One number.',
      source: 'https://github.com/The-40-Thieves/codecalc',
      measured_on: '2026-11-03',
    },
    install: { shell: 'uvx codecalc' },
  };
  if (codecalc) codecalc.hub = { text: JSON.stringify(repoHub) };
  const entry = toEntries(raw, readHubOverrides(overridesDir), fetchedAt).find(
    (candidate) => candidate.slug === 'codecalc',
  );
  expect(entry?.hub_source).toBe('repo');
  expect(entry?.hub?.tagline).toBe('From the repo, with a schema pointer.');
  expect(entry?.hub).not.toHaveProperty('$schema');
});

test('a malformed hub.json fails with the repo, the file and the path in the message', () => {
  const raw = clone();
  const codecalc = raw.data.organization.repositories.nodes.find(
    (node) => node.name === 'codecalc',
  );
  if (codecalc) codecalc.hub = { text: '{"tagline":"TODO","install":{}}' };
  expect(() => toEntries(raw, new Map(), fetchedAt)).toThrow(/codecalc.*hub\.json.*tagline/s);
});

test('a malformed hub-side file names the file', () => {
  const overrides = new Map([
    ['codecalc', { file: 'content/hub/codecalc.json', raw: { tagline: 1 } }],
  ]);
  expect(() => toEntries(clone(), overrides, fetchedAt)).toThrow(/content\/hub\/codecalc\.json/);
});

test('fetchOrganization refuses to run without a token', async () => {
  await expect(fetchOrganization({ org: 'The-40-Thieves', token: undefined })).rejects.toThrow(
    /GITHUB_TOKEN/,
  );
});

test('fetchOrganization sends one query with the org variable and a bearer token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
  };
  const raw = await fetchOrganization({ org: 'The-40-Thieves', token: 'tok', fetchImpl });
  expect(raw.data.organization.repositories.nodes).toHaveLength(9);
  expect(calls).toHaveLength(1);
  const headers = new Headers(calls[0]?.init.headers);
  expect(calls[0]?.url).toBe('https://api.github.com/graphql');
  expect(headers.get('authorization')).toBe('Bearer tok');
  const rawBody = calls[0]?.init.body;
  expect(typeof rawBody).toBe('string');
  const body = JSON.parse(rawBody as string) as { variables: { org: string } };
  expect(body.variables.org).toBe('The-40-Thieves');
});

test('fetchOrganization surfaces GraphQL errors instead of partial data', async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), { status: 200 }),
    );
  await expect(
    fetchOrganization({ org: 'The-40-Thieves', token: 'tok', fetchImpl }),
  ).rejects.toThrow(/Bad credentials/);
});
