import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BuildInfo } from '@the40thieves/manifest';
import { expect, test } from 'vitest';

import { changelogLd, notFoundLd, projectLd, siteLd } from '../src/lib/json-ld.ts';
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
  generatedAt: '2026-11-05T21:00:00.000Z',
  commit: 'c'.repeat(40),
  site: 'https://the40thieves.dev',
};
const posts = sanityEntries(
  'changelogPost',
  readFixture(resolve(import.meta.dirname, 'fixtures/sanity.json'), 'changelogPost'),
);

test('siteLd describes the site and lists only the projects with a page', () => {
  const ld = siteLd(entries, build) as {
    '@type': string;
    url: string;
    publisher: { '@type': string; name: string };
    hasPart: { '@type': string; name: string; url: string }[];
  };
  expect(ld['@type']).toBe('WebSite');
  expect(ld.url).toBe('https://the40thieves.dev/');
  expect(ld.publisher).toEqual({
    '@type': 'Organization',
    name: 'The 40 Thieves',
    url: 'https://the40thieves.dev',
  });
  expect(ld.hasPart.map((part) => part.url)).toEqual([
    'https://the40thieves.dev/alexandria-mcp/',
    'https://the40thieves.dev/audio-forge/',
    'https://the40thieves.dev/codecalc/',
  ]);
  expect(ld.hasPart.every((part) => part['@type'] === 'SoftwareSourceCode')).toBe(true);
});

test('projectLd keeps the SoftwareSourceCode block the product page already shipped', () => {
  const codecalc = entries.find((e) => e.slug === 'codecalc');
  if (!codecalc) throw new Error('no fixture codecalc');
  const ld = projectLd(codecalc, build);
  expect(ld['@type']).toBe('SoftwareSourceCode');
  expect(ld['codeRepository']).toBe('https://github.com/The-40-Thieves/codecalc');
  expect(ld['url']).toBe('https://the40thieves.dev/codecalc/');
  expect(ld['maintainer']).toEqual({
    '@type': 'Organization',
    name: 'The 40 Thieves',
    url: 'https://the40thieves.dev',
  });
});

test('changelogLd lists the posts as BlogPostings anchored on the changelog page', () => {
  const ld = changelogLd(posts, build) as {
    '@type': string;
    url: string;
    blogPost: { '@type': string; headline: string; datePublished: string; url: string }[];
  };
  expect(ld['@type']).toBe('Blog');
  expect(ld.url).toBe('https://the40thieves.dev/changelog/');
  expect(ld.blogPost).toHaveLength(posts.length);
  for (const [i, post] of posts.entries()) {
    expect(ld.blogPost[i]).toEqual({
      '@type': 'BlogPosting',
      headline: post.title,
      datePublished: post.published_at,
      dateModified: post.updated_at,
      url: `https://the40thieves.dev/changelog/#${post.slug}`,
    });
  }
});

test('notFoundLd is a WebPage on the 404 path', () => {
  expect(notFoundLd(build)).toEqual({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Not found',
    url: 'https://the40thieves.dev/404/',
    isPartOf: { '@type': 'WebSite', url: 'https://the40thieves.dev/' },
  });
});
