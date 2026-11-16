import { expect, test } from 'vitest';

import { compareVersions, parseVersion } from '../src/semver.ts';

test('parses MAJOR.MINOR.PATCH with or without a leading v and with a prerelease', () => {
  expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
  expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
  expect(parseVersion('v2.0.0-rc.1')).toEqual({ major: 2, minor: 0, patch: 0, pre: ['rc', 1] });
  expect(parseVersion('1.2.3+build.7')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
});

test('anything else is null', () => {
  for (const bad of ['', 'banana', '1.2', 'v1', '1.2.3.4', ' 1.2.3', '01.2.3', 'v1.2.3-']) {
    expect(parseVersion(bad), bad).toBeNull();
  }
});

test('compares numerically, not as strings', () => {
  expect(compareVersions('v0.13.0', 'v0.9.0')).toBe(1);
  expect(compareVersions('0.9.0', 'v0.13.0')).toBe(-1);
  expect(compareVersions('v10.0.0', '9.99.99')).toBe(1);
  expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
});

test('a prerelease sorts before its release and prerelease identifiers compare per semver', () => {
  expect(compareVersions('v2.0.0-rc.1', 'v2.0.0')).toBe(-1);
  expect(compareVersions('v2.0.0', 'v2.0.0-rc.1')).toBe(1);
  expect(compareVersions('v2.0.0-rc.2', 'v2.0.0-rc.10')).toBe(-1);
  expect(compareVersions('v2.0.0-alpha', 'v2.0.0-beta')).toBe(-1);
  expect(compareVersions('v2.0.0-alpha', 'v2.0.0-alpha.1')).toBe(-1);
  expect(compareVersions('v2.0.0-1', 'v2.0.0-alpha')).toBe(-1);
});

test('an invalid side is null', () => {
  expect(compareVersions('banana', '1.0.0')).toBeNull();
  expect(compareVersions('1.0.0', '')).toBeNull();
});
