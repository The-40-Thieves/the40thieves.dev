import { expect, test } from 'vitest';

import { classifyGitHub, classifySanity } from '../src/events.ts';

const repository = { full_name: 'The-40-Thieves/codecalc', default_branch: 'main' };

test('a published release, a push to the default branch and a repo going public rebuild', () => {
  expect(
    classifyGitHub('release', {
      action: 'published',
      release: { tag_name: 'v0.13.0' },
      repository,
    }),
  ).toEqual({
    source: 'github',
    event: 'release.published',
    subject: 'The-40-Thieves/codecalc v0.13.0',
  });
  expect(classifyGitHub('push', { ref: 'refs/heads/main', repository })).toEqual({
    source: 'github',
    event: 'push',
    subject: 'The-40-Thieves/codecalc refs/heads/main',
  });
  expect(classifyGitHub('repository', { action: 'publicized', repository })).toEqual({
    source: 'github',
    event: 'repository.publicized',
    subject: 'The-40-Thieves/codecalc',
  });
});

test('everything else from GitHub is ignored before any work', () => {
  expect(
    classifyGitHub('release', { action: 'created', release: { tag_name: 'v1' }, repository }),
  ).toBeNull();
  expect(
    classifyGitHub('release', {
      action: 'published',
      release: { tag_name: 'v1', draft: true },
      repository,
    }),
  ).toBeNull();
  expect(
    classifyGitHub('release', {
      action: 'published',
      release: { tag_name: 'v1', prerelease: true },
      repository,
    }),
  ).toBeNull();
  expect(classifyGitHub('push', { ref: 'refs/heads/feature', repository })).toBeNull();
  expect(classifyGitHub('push', { ref: 'refs/tags/v1', repository })).toBeNull();
  expect(classifyGitHub('repository', { action: 'created', repository })).toBeNull();
  expect(classifyGitHub('ping', { zen: 'x' })).toBeNull();
  expect(classifyGitHub('issues', { action: 'opened', repository })).toBeNull();
  expect(classifyGitHub('push', 'not an object')).toBeNull();
  expect(classifyGitHub('push', { ref: 'refs/heads/main' })).toBeNull();
});

const sanityHeaders = (entries: Record<string, string>) => new Headers(entries);

test('a Sanity publish of a published document in the hub dataset rebuilds', () => {
  const headers = sanityHeaders({
    'sanity-operation': 'update',
    'sanity-document-id': '7f3c1a0e-spotlight-codecalc',
    'sanity-dataset': 'the40thieves',
  });
  expect(classifySanity(headers, 'the40thieves')).toEqual({
    source: 'sanity',
    event: 'document.update',
    subject: '7f3c1a0e-spotlight-codecalc',
  });
  expect(
    classifySanity(
      sanityHeaders({ ...Object.fromEntries(headers), 'sanity-operation': 'delete' }),
      'the40thieves',
    )?.event,
  ).toBe('document.delete');
});

test('Sanity drafts, other datasets and unknown operations are ignored', () => {
  const base = {
    'sanity-document-id': 'abc',
    'sanity-dataset': 'the40thieves',
    'sanity-operation': 'create',
  };
  expect(
    classifySanity(sanityHeaders({ ...base, 'sanity-document-id': 'drafts.abc' }), 'the40thieves'),
  ).toBeNull();
  expect(
    classifySanity(sanityHeaders({ ...base, 'sanity-dataset': 'production' }), 'the40thieves'),
  ).toBeNull();
  expect(
    classifySanity(sanityHeaders({ ...base, 'sanity-operation': 'mutate' }), 'the40thieves'),
  ).toBeNull();
  expect(classifySanity(sanityHeaders({}), 'the40thieves')).toBeNull();
});
test('a push to the hub repository itself is ignored: its own deploy already runs on push', () => {
  const hub = {
    full_name: 'The-40-Thieves/the40thieves.dev',
    default_branch: 'main',
  };
  expect(
    classifyGitHub(
      'push',
      { ref: 'refs/heads/main', repository: hub },
      'The-40-Thieves/the40thieves.dev',
    ),
  ).toBeNull();
  expect(
    classifyGitHub(
      'push',
      { ref: 'refs/heads/main', repository },
      'The-40-Thieves/the40thieves.dev',
    ),
  ).not.toBeNull();
  // A release of the hub itself still counts: it is content, not a deploy trigger of its own.
  expect(
    classifyGitHub(
      'release',
      { action: 'published', release: { tag_name: 'v1.0.0' }, repository: hub },
      'The-40-Thieves/the40thieves.dev',
    ),
  ).not.toBeNull();
});
