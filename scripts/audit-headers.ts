import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import {
  expectedValue,
  loadPolicy,
  repoRoot,
  ROUTE_CLASSES,
  ruleApplies,
  type Policy,
  type RouteClass,
} from './lib/policy.ts';

export interface Finding {
  /** File path or URL the finding was observed at. */
  where: string;
  /** Header name, CSP directive name, or `status` for a non-200 response. */
  header: string;
  expected: string;
  actual: string | null;
}

/**
 * Parse a Cloudflare `_headers` file and return the headers declared in its `/*` block.
 * Values are split at the first colon only, so HSTS and CSP values survive intact.
 */
export function parseHeadersFile(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '/*') {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A blank line does not end the block; only the next unindented rule does.
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      inBlock = false;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

/** Rules for a route class; with `path`, those that apply to it, else only the unscoped ones. */
function rulesFor(policy: Policy, cls: RouteClass, path?: string) {
  return policy.headers.filter(
    (rule) =>
      rule.classes.includes(cls) &&
      (path === undefined ? rule.path === undefined : ruleApplies(rule, path)),
  );
}

function* walkHtml(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkHtml(path);
    else if (entry.isFile() && entry.name.endsWith('.html')) yield path;
  }
}

const CSP_META =
  /<meta\s+http-equiv=["']content-security-policy["']\s+content=(?:"([^"]*)"|'([^']*)')/i;

/** Repo-relative path with forward slashes, so findings read the same on every OS. */
function rel(path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

/** Split a CSP string into a map of directive name to its source list. */
export function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

function auditCspMeta(policy: Policy, file: string, html: string): Finding[] {
  const findings: Finding[] = [];
  const match = CSP_META.exec(html);
  if (!match) {
    findings.push({
      where: file,
      header: 'content-security-policy',
      expected: 'meta present',
      actual: null,
    });
    return findings;
  }
  const directives = parseCsp(match[1] ?? match[2] ?? '');
  for (const required of policy.cspMeta.requiredDirectives) {
    if (!directives.has(required)) {
      findings.push({ where: file, header: required, expected: 'directive present', actual: null });
    }
  }
  for (const [directive, forbidden] of Object.entries(policy.cspMeta.forbidden)) {
    const sources = directives.get(directive) ?? [];
    for (const token of forbidden) {
      if (sources.includes(token)) {
        findings.push({
          where: file,
          header: directive,
          expected: `no ${token}`,
          actual: sources.join(' '),
        });
      }
    }
  }
  return findings;
}

/**
 * Audit a built site directory: its `_headers` against the static rules, and the CSP meta
 * of every HTML file found recursively.
 */
export function auditDist(policy: Policy, distDir: string): Finding[] {
  const dir = resolve(repoRoot, distDir);
  const findings: Finding[] = [];
  const headersPath = join(dir, '_headers');
  const declared = existsSync(headersPath)
    ? parseHeadersFile(readFileSync(headersPath, 'utf8'))
    : new Map<string, string>();
  for (const rule of rulesFor(policy, 'static')) {
    const actual = declared.get(rule.name) ?? null;
    if (actual !== rule.value) {
      findings.push({
        where: rel(headersPath),
        header: rule.name,
        expected: rule.value,
        actual,
      });
    }
  }
  for (const file of walkHtml(dir)) {
    findings.push(...auditCspMeta(policy, rel(file), readFileSync(file, 'utf8')));
  }
  return findings;
}

/**
 * Audit live responses. Redirects are not followed: a status other than the one the path spec
 * expects (200 unless written as `path=status`) is a finding. Header names compare
 * case-insensitively (fetch lower-cases them) and values after trim.
 */
/**
 * Retry policy for live audits. `attempts` is one budget shared by two kinds of retry: a fetch
 * that throws (DNS, TLS, connection) is retried, and a whole pass that ends with findings is run
 * again. The first deploy that creates a Custom Domain races the new DNS record, and every
 * deploy races edge propagation of the new Worker version (new assets 404, new headers missing,
 * for a few seconds after `wrangler deploy` returns). Both wait at most attempts - 1 delays.
 */
export interface RetryOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const noRetry: RetryOptions = { attempts: 1, delayMs: 0 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delays left to spend; decremented by whichever retry sleeps. */
interface RetryBudget {
  left: number;
}

/**
 * Fetch `url` with manual redirects, retrying while the budget allows when the request itself
 * fails. A response with any status counts as success here; status checks belong to the caller.
 */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  retry: RetryOptions,
  budget: RetryBudget,
): Promise<Response> {
  const sleep = retry.sleep ?? defaultSleep;
  for (;;) {
    try {
      return await fetchImpl(url, { redirect: 'manual' });
    } catch (error) {
      if (budget.left <= 0) throw error instanceof Error ? error : new Error(String(error));
      budget.left -= 1;
      await sleep(retry.delayMs);
    }
  }
}

/**
 * A path to audit with the status it must answer. `/nope=404` expects a 404; a bare path
 * expects 200. Headers are checked whenever the status matches, so the 404 page is audited too.
 */
export function parsePathSpec(spec: string): { path: string; status: number } {
  const eq = spec.lastIndexOf('=');
  if (eq === -1) return { path: spec, status: 200 };
  const status = Number(spec.slice(eq + 1));
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Bad path spec ${spec}: expected <path>=<status>`);
  }
  return { path: spec.slice(0, eq), status };
}

export async function auditUrl(
  policy: Policy,
  origin: string,
  paths: string[],
  cls: RouteClass,
  fetchImpl: typeof fetch = fetch,
  retry: RetryOptions = noRetry,
): Promise<Finding[]> {
  const specs = paths.map(parsePathSpec);
  // NaN or Infinity (a bad --retries flag) would make a budget that never reaches zero.
  if (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1) {
    throw new Error(
      `Bad retry attempts ${String(retry.attempts)}: expected an integer of at least 1`,
    );
  }
  if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
    throw new Error(
      `Bad retry delay ${String(retry.delayMs)}: expected a non-negative number of ms`,
    );
  }
  const budget: RetryBudget = { left: retry.attempts - 1 };
  const sleep = retry.sleep ?? defaultSleep;
  for (;;) {
    const findings = await auditPass(policy, origin, specs, cls, fetchImpl, retry, budget);
    if (findings.length === 0 || budget.left <= 0) return findings;
    budget.left -= 1;
    await sleep(retry.delayMs);
  }
}

async function auditPass(
  policy: Policy,
  origin: string,
  specs: { path: string; status: number }[],
  cls: RouteClass,
  fetchImpl: typeof fetch,
  retry: RetryOptions,
  budget: RetryBudget,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { path, status } of specs) {
    const rules = rulesFor(policy, cls, path);
    const url = new URL(path, origin).toString();
    const response = await fetchWithRetry(fetchImpl, url, retry, budget);
    if (response.status !== status) {
      findings.push({
        where: url,
        header: 'status',
        expected: String(status),
        actual: String(response.status),
      });
      continue;
    }
    for (const rule of rules) {
      const trimmed = response.headers.get(rule.name.toLowerCase())?.trim() ?? null;
      const expected = expectedValue(rule, path);
      if (trimmed !== expected) {
        findings.push({ where: url, header: rule.name, expected, actual: trimmed });
      }
    }
  }
  return findings;
}

function printFindings(findings: Finding[]): void {
  for (const f of findings) {
    console.error(
      `${f.where}\n  ${f.header}\n    expected: ${f.expected}\n    actual:   ${f.actual ?? '(missing)'}`,
    );
  }
}

function isRouteClass(value: string): value is RouteClass {
  return ROUTE_CLASSES.includes(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string' },
      url: { type: 'string' },
      paths: { type: 'string', default: '/' },
      class: { type: 'string', default: 'static' },
      // Live audits right after a deploy can run before the new DNS record resolves or before the
      // new Worker version reaches the edge; one budget of attempts covers both (see RetryOptions).
      retries: { type: 'string', default: '1' },
      'retry-delay': { type: 'string', default: '5000' },
    },
  });
  const policy = loadPolicy();
  let findings: Finding[];
  if (values.dist !== undefined) {
    findings = auditDist(policy, values.dist);
  } else if (values.url !== undefined) {
    if (!isRouteClass(values.class)) {
      throw new Error(`Unknown --class ${values.class}`);
    }
    findings = await auditUrl(policy, values.url, values.paths.split(','), values.class, fetch, {
      attempts: Number(values.retries),
      delayMs: Number(values['retry-delay']),
    });
  } else {
    throw new Error(
      'Usage: audit-headers --dist <dir> | --url <origin> [--paths /,/404,/nope=404] [--class static|ssr|mcp|relay] [--retries 1] [--retry-delay 5000]',
    );
  }
  if (findings.length > 0) {
    printFindings(findings);
    console.error(`${String(findings.length)} header finding(s)`);
    process.exitCode = 1;
  } else {
    console.log('headers: no findings');
  }
}

if (import.meta.main) {
  await main();
}
