import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { repoRoot } from './lib/policy.ts';

export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: 'unpinned' | 'pull_request_target_checkout_head';
}

const USES = /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)['"]?/;
const SHA_PIN = /@[0-9a-f]{40}$/;

/** `uses:` references that need no pin: same-repository actions and workflows (`./` or `$/`) and Docker images. */
function isExempt(reference: string): boolean {
  return (
    reference.startsWith('./') || reference.startsWith('$/') || reference.startsWith('docker://')
  );
}

/**
 * Check one workflow's text. Every `uses:` must be `owner/repo[/path]@<40-hex-sha>`; local
 * (`./`) and `docker://` references are exempt. When the file declares `pull_request_target`,
 * a checkout step whose `ref:` mentions `head` is flagged (it would run untrusted PR code
 * with the base repository's permissions).
 */
export function checkWorkflowText(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const prTarget = lines.some((line) => /^\s*pull_request_target\s*:/.test(line));

  lines.forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;
    const reference = match[1] ?? '';
    const lineNumber = index + 1;
    if (!isExempt(reference) && !SHA_PIN.test(reference)) {
      violations.push({ file, line: lineNumber, text: line.trim(), reason: 'unpinned' });
    }
    if (prTarget && reference.startsWith('actions/checkout@')) {
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next] ?? '';
        if (USES.test(candidate)) break;
        if (/^\s*ref:\s*.*head/i.test(candidate)) {
          violations.push({
            file,
            line: next + 1,
            text: candidate.trim(),
            reason: 'pull_request_target_checkout_head',
          });
          break;
        }
      }
    }
  });
  return violations;
}

function* walkYaml(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYaml(path);
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) yield path;
  }
}

/**
 * Check every `*.yml` and `*.yaml` file under `dir`, recursively, so both workflows and
 * composite `action.yml` files are covered. `dir` is relative to the repo root unless absolute.
 */
export function checkWorkflows(dir: string): Violation[] {
  const root = resolve(repoRoot, dir);
  return [...walkYaml(root)].flatMap((path) =>
    checkWorkflowText(relative(repoRoot, path).split(sep).join('/'), readFileSync(path, 'utf8')),
  );
}

function main(): void {
  const dir = process.argv[2] ?? '.github';
  const violations = checkWorkflows(dir);
  for (const v of violations) {
    console.error(`${v.file}:${String(v.line)}: ${v.reason}: ${v.text}`);
  }
  if (violations.length > 0) {
    console.error(`${String(violations.length)} action pin violation(s)`);
    process.exitCode = 1;
  } else {
    console.log('actions: all uses are sha-pinned');
  }
}

if (import.meta.main) {
  main();
}
