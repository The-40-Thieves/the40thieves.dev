import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import {
  QUERIES,
  SANITY_API_VERSION,
  fetchDocuments,
  queryUrl,
  readFixture,
  toEntries,
} from '../src/loaders/sanity.ts';

const fixturePath = resolve(import.meta.dirname, 'fixtures/sanity.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown[]>;
const options = { projectId: 'cfnvp6ru', dataset: 'the40thieves', token: undefined };

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the fixture yields validated spotlight entries, newest first', () => {
  const entries = toEntries('spotlight', fixture.spotlight);
  expect(entries.map((entry) => entry.slug)).toEqual(['codecalc-0-13', 'hub-live']);
  expect(entries[0]?.project).toBe('codecalc');
  expect(entries[1]?.link).toBe('https://the40thieves.dev/manifest.json');
  expect(entries[1]?.body).toBeNull();
});

test('changelog posts validate against their own schema and keep their order', () => {
  const entries = toEntries('changelogPost', fixture.changelogPost);
  expect(entries.map((entry) => entry.slug)).toEqual(['org-readme-from-manifest', 'svg-cards']);
  expect(entries[0]?.body?.[0]?._type).toBe('block');
});

test('a document that fails validation names the type and the field', () => {
  const broken = [{ ...(fixture.spotlight[0] as object), published_at: 'yesterday' }];
  expect(() => toEntries('spotlight', broken)).toThrow(/spotlight[\s\S]*published_at/);
});

test('the spotlight query projects the Cloudinary image with the alt text beside it', () => {
  expect(QUERIES.spotlight).toContain(
    '"image": image { public_id, format, width, height, "alt": ^.imageAlt }',
  );
  const entries = toEntries('spotlight', fixture.spotlight);
  expect(entries[0]?.image?.public_id).toBe('the40thieves/codecalc-0-13');
  expect(entries[0]?.image?.alt).toMatch(/codecalc/);
  expect(entries[1]?.image).toBeNull();
});

test('two documents with the same slug fail the build naming the slug', () => {
  const first = fixture.spotlight[0] as { slug: string };
  const twin = { ...first, id: 'spotlight-twin' };
  expect(() => toEntries('spotlight', [first, twin])).toThrow(
    new RegExp(`spotlight documents .* share the slug "${first.slug}"`),
  );
});

test('readFixture picks the documents of one type from the recorded file', () => {
  expect(readFixture(fixturePath, 'changelogPost')).toHaveLength(2);
  expect(() => readFixture(fixturePath, 'page' as never)).toThrow(/page/);
});

test('the query URL targets the live API with the published perspective and a dated version', () => {
  const url = new URL(queryUrl(options, 'spotlight'));
  expect(url.host).toBe('cfnvp6ru.api.sanity.io');
  expect(url.pathname).toBe(`/v${SANITY_API_VERSION}/data/query/the40thieves`);
  expect(url.searchParams.get('perspective')).toBe('published');
  expect(url.searchParams.get('query')).toBe(QUERIES.spotlight);
  expect(SANITY_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('fetchDocuments sends the bearer token when one is set and returns the result array', async () => {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    expect(input).toContain('/data/query/the40thieves');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
    return Promise.resolve(
      new Response(JSON.stringify({ result: fixture.spotlight }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = await fetchDocuments({ ...options, token: 'sk-test' }, 'spotlight');
  expect(result).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('fetchDocuments sends no authorization header without a token', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Promise.resolve(new Response(JSON.stringify({ result: [] })));
    }),
  );
  await expect(fetchDocuments(options, 'changelogPost')).resolves.toEqual([]);
});

test('a non-2xx answer fails the build with the status and the dataset in the message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{"error":"Dataset not found"}', { status: 404 }))),
  );
  await expect(fetchDocuments(options, 'spotlight')).rejects.toThrow(/the40thieves[\s\S]*404/);
});
