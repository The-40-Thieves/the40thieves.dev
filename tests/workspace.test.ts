import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
const lines = workspace.split('\n').map((line) => line.trim());

/** Keys listed directly under a top-level mapping key, in file order. */
function childrenOf(key: string): string[] {
  const raw = workspace.split('\n');
  const start = raw.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return [];
  const children: string[] = [];
  for (const line of raw.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    if (line.trim().startsWith('#')) continue;
    children.push(line.trim().split(':')[0]?.replace(/^'|'$/g, '') ?? '');
  }
  return children;
}

/** The trimmed lines of a top-level mapping's block, comments dropped. */
function blockOf(key: string): string[] {
  const raw = workspace.split('\n');
  const start = raw.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of raw.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    if (!line.trim().startsWith('#')) block.push(line.trim());
  }
  return block;
}

test('workspace declares the three package globs', () => {
  for (const glob of ['apps/*', 'workers/*', 'packages/*']) {
    expect(lines).toContain(`- ${glob}`);
  }
});

test('workspace enforces a seven-day minimum release age', () => {
  expect(lines).toContain('minimumReleaseAge: 10080');
});

test('workspace saves exact versions', () => {
  expect(lines).toContain("savePrefix: ''");
});

test('workspace allows install scripts only for esbuild, workerd and @sentry/cli', () => {
  // Each one downloads a platform binary in postinstall; nothing else may run scripts. core-js-pure
  // (transitive through agents, P3-S1) is listed only to deny its funding banner explicitly.
  expect(childrenOf('allowBuilds')).toEqual(['esbuild', 'workerd', '@sentry/cli', 'core-js-pure']);
  expect(lines).toContain('esbuild: true');
  expect(lines).toContain('workerd: true');
  expect(lines).toContain("'@sentry/cli': true");
  expect(lines).toContain("'core-js-pure': false");
});

test('every catalog entry is an exact version', () => {
  const entries = blockOf('catalog');
  expect(entries.length).toBeGreaterThan(0);
  for (const line of entries) {
    expect(line).toMatch(/: \d+\.\d+\.\d+$/);
  }
});
