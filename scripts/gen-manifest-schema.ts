import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { manifestJsonSchema } from '@the40thieves/manifest';

import { repoRoot } from './lib/policy.ts';

/** Writes packages/manifest/manifest.schema.json from the zod schema; `--check` only compares. */
const output = resolve(repoRoot, 'packages/manifest/manifest.schema.json');
const text = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(output, 'utf8');
  } catch {
    // missing file: handled below
  }
  if (current !== text) {
    console.error('packages/manifest/manifest.schema.json is stale; run pnpm gen:manifest-schema');
    process.exitCode = 1;
  } else {
    console.log('manifest.schema.json matches the zod schema');
  }
} else {
  writeFileSync(output, text);
  console.log('wrote packages/manifest/manifest.schema.json');
}
