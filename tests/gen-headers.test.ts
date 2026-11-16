import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { parseHeadersFile } from '../scripts/audit-headers.ts';
import { generateHeadersFile, headersFileIsCurrent } from '../scripts/gen-headers.ts';
import { loadPolicy } from '../scripts/lib/policy.ts';

test('emits every static header under /* and round-trips values with colons', () => {
  const policy = loadPolicy('security/headers.policy.json');
  const text = generateHeadersFile(policy);
  expect(text.startsWith('/*\n')).toBe(true);
  expect(text.endsWith('\n')).toBe(true);
  const parsed = parseHeadersFile(text);
  expect(parsed.get('Strict-Transport-Security')).toBe(
    'max-age=63072000; includeSubDomains; preload',
  );
  expect(parsed.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  expect(parsed.size).toBe(6);
});

test('parseHeadersFile skips a blank line inside the /* block instead of ending it', () => {
  const text = "/*\n  X-Frame-Options: DENY\n\n  Content-Security-Policy: frame-ancestors 'none'\n";
  const parsed = parseHeadersFile(text);
  expect(parsed.get('X-Frame-Options')).toBe('DENY');
  expect(parsed.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
});

test('parseHeadersFile stops at the next unindented rule', () => {
  const text = '/*\n  X-Frame-Options: DENY\n/other\n  X-Other: 1\n';
  const parsed = parseHeadersFile(text);
  expect(parsed.get('X-Frame-Options')).toBe('DENY');
  expect(parsed.has('X-Other')).toBe(false);
});

test('headersFileIsCurrent is true for a file matching the policy and false after drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headers-'));
  const file = join(dir, '_headers');
  const policy = loadPolicy();
  writeFileSync(file, generateHeadersFile(policy));
  expect(headersFileIsCurrent(policy, file)).toBe(true);
  writeFileSync(file, generateHeadersFile(policy).replace('DENY', 'SAMEORIGIN'));
  expect(headersFileIsCurrent(policy, file)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test('headersFileIsCurrent is false when the file is missing', () => {
  expect(headersFileIsCurrent(loadPolicy(), join(tmpdir(), 'no-such-dir', '_headers'))).toBe(false);
});

test('indents each header line by two spaces under its path line', () => {
  const text = generateHeadersFile(loadPolicy());
  const body = text
    .split('\n')
    .slice(1)
    .filter((line) => line.length > 0);
  for (const line of body) {
    expect(line.startsWith('  ') || line.startsWith('/'), line).toBe(true);
  }
});
test('a rule with a path lands in its own block after /* and never in the /* block', () => {
  const policy = loadPolicy();
  const scoped = {
    ...policy,
    headers: [
      ...policy.headers,
      {
        name: 'Cache-Control',
        value: 'no-cache',
        classes: ['static' as const],
        path: '/og/*',
      },
    ],
  };
  const text = generateHeadersFile(scoped);
  expect(text).toContain('\n/og/*\n  Cache-Control: no-cache\n');
  expect(parseHeadersFile(text).has('Cache-Control')).toBe(false);
  expect(text.indexOf('/og/*')).toBeGreaterThan(text.indexOf('/*\n'));
});

test('the committed policy links every HTML page to its Markdown twin and types the twins (P3-S2)', () => {
  const policy = loadPolicy();
  expect(policy.headers).toContainEqual(
    expect.objectContaining({
      name: 'Content-Type',
      value: 'text/markdown; charset=utf-8',
      classes: ['static'],
      path: '/*.md',
    }),
  );
  const links = policy.headers.filter((rule) => rule.name === 'Link');
  expect(links.map((rule) => [rule.path, rule.value, rule.classes])).toEqual([
    ['/', '</index.md>; rel="alternate"; type="text/markdown"', ['static']],
    ['/:page/', '</:page.md>; rel="alternate"; type="text/markdown"', ['static']],
    [
      '/alexandria/:page/',
      '</alexandria/:page.md>; rel="alternate"; type="text/markdown"',
      ['static'],
    ],
    ['/design/:page/', '</design/:page.md>; rel="alternate"; type="text/markdown"', ['static']],
  ]);
  const text = generateHeadersFile(policy);
  expect(text).toContain('\n/*.md\n  Content-Type: text/markdown; charset=utf-8\n');
  expect(text).toContain('\n/\n  Link: </index.md>; rel="alternate"; type="text/markdown"\n');
  expect(text).toContain('\n/:page/\n  Link: </:page.md>; rel="alternate"; type="text/markdown"\n');
  // The nested alexandria pages (P4-S1): :page spans one segment, so they need their own rule.
  expect(text).toContain(
    '\n/alexandria/:page/\n  Link: </alexandria/:page.md>; rel="alternate"; type="text/markdown"\n',
  );
  // None of them leaks into the /* block the dist audit reads.
  const unscoped = parseHeadersFile(text);
  expect(unscoped.has('Link')).toBe(false);
  expect(unscoped.has('Content-Type')).toBe(false);
});

test('the committed policy scopes Cache-Control: no-cache to /og/* for the README cards', () => {
  const rule = loadPolicy().headers.find((r) => r.name === 'Cache-Control');
  expect(rule).toMatchObject({
    name: 'Cache-Control',
    value: 'no-cache',
    classes: ['static'],
    path: '/og/*',
  });
});
