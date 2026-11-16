import { execFileSync } from 'node:child_process';

import type { BuildInfo } from '@the40thieves/manifest';

function headCommit(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi && /^[0-9a-f]{40}$/.test(fromCi)) return fromCi;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Cannot determine the build commit: set GITHUB_SHA or build inside the git checkout',
    );
  }
}

/**
 * Resolved once per build in astro.config.ts (Node) and injected as `__BUILD_INFO__`, because
 * prerendering runs inside workerd where child_process does not exist. Every page, feed and
 * manifest.json stamps the same commit and time.
 */
export function resolveBuildInfo(): BuildInfo {
  return {
    generatedAt: new Date().toISOString(),
    commit: headCommit(),
    site: 'https://the40thieves.dev',
  };
}
