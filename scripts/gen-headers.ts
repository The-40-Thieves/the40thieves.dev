import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadPolicy, repoRoot, type Policy } from './lib/policy.ts';

export const HEADERS_OUTPUT = 'apps/hub/public/_headers';

/**
 * Render the Cloudflare `_headers` file: one `/*` block carrying every unscoped rule whose
 * classes include `static`, then one block per scoped path in policy order, as two-space
 * indented `Name: value` lines, trailing newline.
 */
export function generateHeadersFile(policy: Policy): string {
  const blocks = new Map<string, string[]>([['/*', []]]);
  for (const rule of policy.headers) {
    if (!rule.classes.includes('static')) continue;
    const path = rule.path ?? '/*';
    const lines = blocks.get(path) ?? [];
    lines.push(`  ${rule.name}: ${rule.value}`);
    blocks.set(path, lines);
  }
  return [...blocks].flatMap(([path, lines]) => [path, ...lines]).join('\n') + '\n';
}

/**
 * True when `file` holds exactly what the policy renders. CI runs this so a policy edit
 * without a regenerated `_headers` (or a hand edit to `_headers`) fails before deploy.
 */
export function headersFileIsCurrent(
  policy: Policy,
  file: string = resolve(repoRoot, HEADERS_OUTPUT),
): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8') === generateHeadersFile(policy);
}

function main(): void {
  const output = resolve(repoRoot, HEADERS_OUTPUT);
  if (process.argv.includes('--check')) {
    if (headersFileIsCurrent(loadPolicy(), output)) {
      console.log(`${relative(repoRoot, output)} matches the policy`);
      return;
    }
    console.error(
      `${relative(repoRoot, output)} does not match security/headers.policy.json; run pnpm gen:headers`,
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generateHeadersFile(loadPolicy()));
  console.log(`wrote ${relative(repoRoot, output)}`);
}

if (import.meta.main) {
  main();
}
