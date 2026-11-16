import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from './lib/policy.ts';

/**
 * Licence gate (THE-1738). Reads `pnpm licenses list
 * --json` for every package in the lockfile and fails on a licence the policy denies or cannot
 * read. The free replacement for GitHub's dependency-review action, which needs the Code
 * Security add-on on a private repository; vulnerabilities are the osv-scanner job's business.
 */
export interface LicensePolicy {
  /** SPDX id prefixes; a trailing `*` matches the rest of the id. */
  denied: string[];
  /** Licence strings that mean "not declared"; a trailing `*` matches the rest. */
  unknown: string[];
  /** Package name (a trailing `*` covers a family) to the reason it may ship despite its licence. */
  exceptions: Record<string, string>;
}

export interface LicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

/** The shape of `pnpm licenses list --json`: licence string to the packages under it. */
export type LicenseReport = Record<string, LicenseEntry[]>;

export interface Finding {
  name: string;
  versions: string[];
  license: string;
  reason: 'denied' | 'unknown';
}

function matches(id: string, pattern: string): boolean {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

function isUnknown(id: string, policy: LicensePolicy): boolean {
  return policy.unknown.some((pattern) => matches(id, pattern));
}

function isDeniedId(id: string, policy: LicensePolicy): boolean {
  return policy.denied.some((pattern) => matches(id, pattern));
}

/**
 * Evaluate one SPDX licence expression against the policy with the SPDX grammar: `OR` binds
 * loosest, then `AND`, then `WITH` (an exception, judged on its licence), and parentheses group.
 * A malformed expression (unbalanced parentheses, dangling operator, stray token) is not
 * allowed, like an unknown licence: the gate errs on the strict side.
 */
export function isAllowed(expression: string, policy: LicensePolicy): boolean {
  if (isUnknown(expression.trim(), policy)) return false;
  const tokens = expression
    .replace(/([()])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return false;
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const next = (): string | undefined => tokens[position++];
  const isOperator = (token: string | undefined): boolean =>
    token === undefined || ['(', ')', 'OR', 'AND', 'WITH'].includes(token);

  // Each parse function returns the clause's verdict, or undefined when the text is malformed.
  const parsePrimary = (): boolean | undefined => {
    const token = next();
    if (token === '(') {
      const inner = parseOr();
      return next() === ')' ? inner : undefined;
    }
    if (isOperator(token) || token === undefined) return undefined;
    return !isUnknown(token, policy) && !isDeniedId(token, policy);
  };
  const parseWith = (): boolean | undefined => {
    const licence = parsePrimary();
    if (licence === undefined || peek() !== 'WITH') return licence;
    next();
    return isOperator(next()) ? undefined : licence;
  };
  const parseAnd = (): boolean | undefined => {
    let verdict = parseWith();
    while (verdict !== undefined && peek() === 'AND') {
      next();
      const right = parseWith();
      verdict = right === undefined ? undefined : verdict && right;
    }
    return verdict;
  };
  const parseOr = (): boolean | undefined => {
    let verdict = parseAnd();
    while (verdict !== undefined && peek() === 'OR') {
      next();
      const right = parseAnd();
      verdict = right === undefined ? undefined : verdict || right;
    }
    return verdict;
  };

  const verdict = parseOr();
  return verdict === true && position === tokens.length;
}

/** Every package in the report that the policy rejects, sorted by name. */
export function checkLicenses(report: LicenseReport, policy: LicensePolicy): Finding[] {
  const findings: Finding[] = [];
  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      if (Object.keys(policy.exceptions).some((pattern) => matches(entry.name, pattern))) continue;
      const id = entry.license || license;
      if (isAllowed(id, policy)) continue;
      findings.push({
        name: entry.name,
        versions: entry.versions,
        license: id,
        reason: isUnknown(id.replace(/[()]/g, ' ').trim(), policy) ? 'unknown' : 'denied',
      });
    }
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadLicensePolicy(path = 'security/licenses.policy.json'): LicensePolicy {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as LicensePolicy;
}

/**
 * Run `pnpm -r licenses list --json` at the repo root and parse it. `-r` matters: without it pnpm
 * reports only the root importer and skips every package the hub workspace pulls in. Through the
 * shell so `pnpm.cmd` resolves on Windows.
 */
export function readLicenseReport(): LicenseReport {
  const output = execSync('pnpm -r licenses list --json', {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

function main(): void {
  const policy = loadLicensePolicy();
  const report = readLicenseReport();
  const total = Object.values(report).reduce((sum, entries) => sum + entries.length, 0);
  const findings = checkLicenses(report, policy);
  for (const finding of findings) {
    console.error(
      `${finding.name}@${finding.versions.join(',')}: ${finding.reason} licence "${finding.license}"`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `${String(findings.length)} licence violation(s) in ${String(total)} packages; see security/licenses.policy.json`,
    );
    process.exitCode = 1;
  } else {
    const licences = Object.keys(report).sort().join(', ');
    console.log(`licences: ${String(total)} packages pass the policy (${licences})`);
  }
}

if (import.meta.main) {
  main();
}
