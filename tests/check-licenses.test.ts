import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import {
  checkLicenses,
  isAllowed,
  type LicensePolicy,
  type LicenseReport,
} from '../scripts/check-licenses.ts';

const policy = JSON.parse(
  readFileSync(new URL('../security/licenses.policy.json', import.meta.url), 'utf8'),
) as LicensePolicy;

test('the committed policy denies the copyleft and source-available families', () => {
  expect(policy.denied).toEqual(
    expect.arrayContaining(['AGPL-*', 'GPL-*', 'LGPL-*', 'SSPL-*', 'BUSL-*', 'UNLICENSED']),
  );
  expect(Object.keys(policy.exceptions)).toEqual(['@img/sharp-*']);
});

test('allows the permissive and weak-copyleft licences the lockfile uses today', () => {
  for (const id of ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'MPL-2.0', 'FSL-1.1-MIT']) {
    expect(isAllowed(id, policy), id).toBe(true);
  }
});

test('denies by prefix: AGPL, GPL, LGPL and SSPL in every variant', () => {
  for (const id of ['AGPL-3.0-only', 'GPL-2.0', 'LGPL-3.0-or-later', 'SSPL-1.0', 'BUSL-1.1']) {
    expect(isAllowed(id, policy), id).toBe(false);
  }
});

test('evaluates SPDX expressions: OR needs one allowed side, AND needs both, WITH is ignored', () => {
  expect(isAllowed('(MIT OR GPL-3.0)', policy)).toBe(true);
  expect(isAllowed('GPL-3.0 AND MIT', policy)).toBe(false);
  expect(isAllowed('Apache-2.0 WITH LLVM-exception', policy)).toBe(true);
});

test('honours parentheses: a denied licence ANDed with a parenthesised OR still fails', () => {
  expect(isAllowed('GPL-3.0 AND (MIT OR Apache-2.0)', policy)).toBe(false);
  expect(isAllowed('(GPL-3.0 AND MIT) OR Apache-2.0', policy)).toBe(true);
  expect(isAllowed('MIT AND (GPL-3.0 OR Apache-2.0)', policy)).toBe(true);
  expect(isAllowed('(MIT OR (GPL-3.0 AND Apache-2.0))', policy)).toBe(true);
  expect(isAllowed('((GPL-3.0))', policy)).toBe(false);
});

test('a malformed expression is not allowed', () => {
  expect(isAllowed('MIT OR', policy)).toBe(false);
  expect(isAllowed('(MIT', policy)).toBe(false);
  expect(isAllowed('MIT )', policy)).toBe(false);
});

test('reports denied and unknown packages, sorted by name, and honours exceptions', () => {
  const report: LicenseReport = {
    MIT: [{ name: 'zed', versions: ['1.0.0'], license: 'MIT' }],
    'AGPL-3.0': [
      { name: 'beta', versions: ['2.0.0'], license: 'AGPL-3.0' },
      { name: 'alpha', versions: ['1.0.0', '1.1.0'], license: 'AGPL-3.0' },
    ],
    Unknown: [{ name: 'mystery', versions: ['0.1.0'], license: 'Unknown' }],
  };
  expect(checkLicenses(report, policy)).toEqual([
    { name: 'alpha', versions: ['1.0.0', '1.1.0'], license: 'AGPL-3.0', reason: 'denied' },
    { name: 'beta', versions: ['2.0.0'], license: 'AGPL-3.0', reason: 'denied' },
    { name: 'mystery', versions: ['0.1.0'], license: 'Unknown', reason: 'unknown' },
  ]);

  const excepted: LicensePolicy = {
    ...policy,
    exceptions: { alpha: 'vendored server-side tool, never shipped to the browser' },
  };
  expect(checkLicenses(report, excepted).map((finding) => finding.name)).toEqual([
    'beta',
    'mystery',
  ]);
});

test('an exception key ending in * covers a package family, such as the sharp platform builds', () => {
  const report: LicenseReport = {
    'Apache-2.0 AND LGPL-3.0-or-later': [
      {
        name: '@img/sharp-linux-x64',
        versions: ['0.34.5'],
        license: 'Apache-2.0 AND LGPL-3.0-or-later',
      },
      {
        name: '@img/sharp-libvips-linux-x64',
        versions: ['1.2.4'],
        license: 'Apache-2.0 AND LGPL-3.0-or-later',
      },
      { name: 'other-lgpl', versions: ['1.0.0'], license: 'Apache-2.0 AND LGPL-3.0-or-later' },
    ],
  };
  const excepted: LicensePolicy = { ...policy, exceptions: { '@img/sharp-*': 'build-time only' } };
  expect(checkLicenses(report, excepted).map((finding) => finding.name)).toEqual(['other-lgpl']);
});

test('an empty licence string counts as unknown, not allowed', () => {
  expect(isAllowed('', policy)).toBe(false);
  const report: LicenseReport = { '': [{ name: 'blank', versions: ['1.0.0'], license: '' }] };
  expect(checkLicenses(report, policy)).toMatchObject([{ name: 'blank', reason: 'unknown' }]);
});
