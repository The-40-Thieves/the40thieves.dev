import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Manifest } from '@the40thieves/schemas';

import { type Stack, startStack } from './agent-stack.ts';
import {
  type CheckRow,
  type CheckStatus,
  driftRows,
  fetchSurfaces,
  guarded,
  legacyClientRows,
  loadManifest,
  logged,
  originRows,
  rateLimitRows,
  servedPageTools,
  twinRows,
  versionHeaderRows,
} from './lib/conformance-checks.ts';
import {
  type CardExpectation,
  discoveryFailures,
  endpointFor,
  MODERN_PROTOCOL_VERSION,
  pageToolsFailures,
  smoke,
} from './mcp-smoke.ts';

/**
 * The agent-surface conformance suite (P3-S5): every surface an agent reads, checked on one
 * origin and written up as a report. `--local` starts the hub and the `/mcp` Worker in local
 * workerd (`scripts/agent-stack.ts`) and is what CI runs; `--url` points the same checks at a
 * site that is already up, the live one included. The checks themselves are in
 * `scripts/lib/conformance-checks.ts` and `scripts/mcp-smoke.ts`; this file orders them, collects
 * their rows and decides the exit code.
 */
const USAGE = 'Usage: conformance (--local or --url <origin>) [--browser] [--report <dir>]';
const ROOT = resolve(import.meta.dirname, '..');

export interface ConformanceArgs {
  /** The origin to check, or null when the run starts its own stack. */
  url: URL | null;
  local: boolean;
  /** Also run the page tools in Chromium (`apps/hub/e2e-stack`). */
  browser: boolean;
  /** The directory `report.json` and `report.md` are written to, or null for none. */
  report: string | null;
}

export function parseConformanceArgs(argv: string[]): ConformanceArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      local: { type: 'boolean', default: false },
      browser: { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  });
  if (values.local === (values.url !== undefined)) throw new Error(USAGE);
  return {
    // An endpoint is as good as its origin; the https rule is the smoke script's.
    url: values.url === undefined ? null : new URL(endpointFor(values.url).origin),
    local: values.local,
    browser: values.browser,
    report: values.report ?? null,
  };
}

/** Any failed row fails the run. So does a run with no row: nothing was checked. */
export function exitCodeFor(rows: readonly CheckRow[]): number {
  return rows.length > 0 && rows.every((row) => row.status !== 'fail') ? 0 : 1;
}

export interface ConformanceRun {
  /** The origin the checks were sent to. */
  target: string;
  /** The origin the documents name: `site` of the served manifest. */
  site: string;
  commit: string | null;
  rows: readonly CheckRow[];
  startedAt: string;
  seconds: number;
}

/** One table cell: a pipe, a line break or a tag in a detail must not reshape the report. */
function cell(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function count(rows: readonly CheckRow[], status: CheckStatus): number {
  return rows.filter((row) => row.status === status).length;
}

function headline(rows: readonly CheckRow[], seconds: string): string {
  if (rows.length === 0) return `**No check ran** in ${seconds} s`;
  const [pass, fail, skip] = [count(rows, 'pass'), count(rows, 'fail'), count(rows, 'skip')];
  const counts =
    fail > 0
      ? `**${String(fail)} failed**, ${String(pass)} passed`
      : `**${String(pass)} passed**, 0 failed`;
  return `${counts}, ${String(skip)} skipped in ${seconds} s`;
}

/**
 * The drift report: `report.json` for a machine and `report.md` for a person. The Markdown leads
 * with the count and the failed rows, then has one table per group in the order the groups ran.
 */
export function renderReport(run: ConformanceRun): { json: string; markdown: string } {
  const seconds = run.seconds.toFixed(1);
  const json = JSON.stringify(
    {
      target: run.target,
      site: run.site,
      commit: run.commit,
      startedAt: run.startedAt,
      seconds: Number(seconds),
      summary: {
        pass: count(run.rows, 'pass'),
        fail: count(run.rows, 'fail'),
        skip: count(run.rows, 'skip'),
      },
      rows: run.rows,
    },
    null,
    2,
  );

  const lines = [
    '# Agent-surface conformance',
    '',
    headline(run.rows, seconds),
    '',
    `- Target: ${run.target}`,
    `- Site: ${run.site}`,
    `- Commit: ${run.commit ?? 'unknown'}`,
    `- Started: ${run.startedAt}`,
  ];
  const failed = run.rows.filter((row) => row.status === 'fail');
  if (failed.length > 0) {
    lines.push('', '## Failed', '', '| Group | Check | Seen |', '| --- | --- | --- |');
    for (const row of failed) {
      lines.push(`| ${cell(row.group)} | ${cell(row.check)} | ${cell(row.detail)} |`);
    }
  }
  for (const group of new Set(run.rows.map((row) => row.group))) {
    lines.push('', `## ${group}`, '', '| Check | Result | Seen |', '| --- | --- | --- |');
    for (const row of run.rows.filter((candidate) => candidate.group === group)) {
      lines.push(`| ${cell(row.check)} | ${row.status} | ${cell(row.detail)} |`);
    }
  }
  return { json: `${json}\n`, markdown: `${lines.join('\n')}\n` };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(group: string, check: string, detail: string): CheckRow {
  return { group, check, status: 'fail', detail };
}

interface Served {
  /** The names `tools/list` answered. */
  mcpTools: string[];
  /** What the Server Card has to agree with. */
  expected: CardExpectation;
}

/**
 * The 2026-07-28 lane with the SDK client: discover, list, one call per tool, the page cap. What
 * the server said is kept for the groups that compare documents with it; null when it did not say.
 */
async function protocolRows(
  endpoint: URL,
  site: string,
): Promise<{ rows: CheckRow[]; served: Served | null }> {
  const modern = new Client(
    { name: 'the40thieves-conformance', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  let served: Served | null = null;
  const rows = await logged('protocol', async (log) => {
    await modern.connect(new StreamableHTTPClientTransport(endpoint));
    const failures = await smoke(modern, log);
    served = {
      mcpTools: (await modern.listTools()).tools.map((tool) => tool.name),
      expected: {
        endpoint: `${site}${endpoint.pathname}`,
        supportedVersions: (await modern.discover()).supportedVersions,
        serverVersion: modern.getServerVersion()?.version,
      },
    };
    return failures;
  });
  await modern.close().catch(() => undefined);
  return { rows, served };
}

export interface RunOptions {
  /** True for a stack this machine runs: only there may a rate-limit budget be spent. */
  local: boolean;
  /** Called with each row as its group finishes, so a run that hangs has said how far it got. */
  onRow?: (row: CheckRow) => void;
}

export interface RunResult {
  site: string;
  commit: string | null;
  rows: CheckRow[];
}

/**
 * Every group against `base`, in order. A group that cannot run is a failed row and the next one
 * still runs; only a manifest that cannot be read ends the run, since the rest compare with it.
 */
export async function runChecks(base: URL, options: RunOptions): Promise<RunResult> {
  const rows: CheckRow[] = [];
  const add = (more: readonly CheckRow[]) => {
    for (const row of more) {
      rows.push(row);
      options.onRow?.(row);
    }
  };
  const endpoint = endpointFor(base.origin);

  let manifest: Manifest;
  try {
    manifest = await loadManifest(base);
  } catch (error) {
    add([failed('manifest', '/manifest.json', reason(error))]);
    return { site: base.origin, commit: null, rows };
  }
  // The documents name the canonical origin, wherever the stack happens to answer.
  const site = new URL(manifest.site).origin;
  add([
    {
      group: 'manifest',
      check: '/manifest.json',
      status: 'pass',
      detail: `site ${site}, commit ${manifest.commit ?? 'unknown'}, ${String(manifest.pages.length)} pages, ${String(manifest.projects.length)} projects`,
    },
  ]);

  const protocol = await protocolRows(endpoint, site);
  add(protocol.rows);
  const served = protocol.served;

  add(await guarded('legacy client', () => legacyClientRows(endpoint)));
  add(await guarded('version header', () => versionHeaderRows(endpoint)));
  add(await guarded('origin', () => originRows(endpoint, site)));

  add(
    served === null
      ? [failed('discovery', 'ran', 'server/discover did not answer: nothing to hold the card to')]
      : await logged('discovery', (log) =>
          discoveryFailures(endpoint, served.expected, fetch, log, site),
        ),
  );
  add(await logged('page tools', (log) => pageToolsFailures(endpoint, fetch, log)));

  // One pass over the pages and their twins feeds both groups.
  const surfaces = await fetchSurfaces(base, manifest).catch((error: unknown) => reason(error));
  if (typeof surfaces === 'string') {
    add([failed('twins', 'ran', surfaces), failed('drift', 'ran', 'the pages were not read')]);
  } else {
    add(twinRows(manifest, surfaces));
    add(
      await guarded('drift', async () => {
        if (served === null) throw new Error('tools/list did not answer: nothing to compare');
        const webmcpServed = await servedPageTools(base);
        return driftRows(manifest, surfaces, { mcpTools: served.mcpTools, webmcpServed });
      }),
    );
  }

  // Last: it spends a whole budget, under client keys nothing else in the run uses.
  const key = `2001:db8::${randomInt(0x1000, 0x10000).toString(16)}`;
  add(
    await guarded('rate limit', () =>
      rateLimitRows(endpoint, {
        local: options.local,
        key: `${key}:a`,
        otherKey: `${key}:b`,
        retryKey: `${key}:c`,
      }),
    ),
  );
  return { site, commit: manifest.commit, rows };
}

/**
 * The page tools in Chromium (`apps/hub/e2e-stack`), as one row: Playwright's own last line when
 * it passes, the tail of its output when it does not.
 */
export async function browserRows(base: URL): Promise<CheckRow[]> {
  // Not spawnSync: the local stack's proxy runs in this process and has to keep answering.
  const child = spawn('pnpm --filter hub exec playwright test -c playwright.stack.config.ts', {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STACK_URL: base.origin },
  });
  let output = '';
  const keep = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const status = await new Promise<number | null>((done) => {
    child.on('error', (error) => {
      output += `${error.message}\n`;
      done(null);
    });
    child.on('close', done);
  });
  const passed = status === 0;
  if (!passed) console.log(output);
  return [
    {
      group: 'browser',
      check: 'page tools in Chromium',
      status: passed ? 'pass' : 'fail',
      detail: passed
        ? playwrightSummary(output)
        : `${playwrightSummary(output)}; Playwright's own output is in the log above`,
    },
  ];
}

const PLAYWRIGHT_COUNT = /^\d+ (?:passed|failed|flaky|skipped|interrupted|did not run)\b/;

/** The counts Playwright ends its list report with; without any, the last thing it said. */
export function playwrightSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const counts = lines.filter((line) => PLAYWRIGHT_COUNT.test(line));
  return counts.length > 0 ? counts.join(', ') : (lines.at(-1) ?? 'no output');
}

const SHOWN: Record<CheckStatus, string> = { pass: 'ok  ', fail: 'FAIL', skip: 'skip' };

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

async function main(): Promise<number> {
  const args = parseConformanceArgs(process.argv.slice(2));
  const started = Date.now();
  const rows: CheckRow[] = [];
  const onRow = (row: CheckRow) => {
    rows.push(row);
    console.log(`${SHOWN[row.status]} ${row.group}: ${row.check}: ${row.detail}`);
  };

  let target = args.url?.origin ?? 'local stack';
  let site = '';
  let commit: string | null = null;
  let stack: Stack | null = null;
  try {
    if (args.local) stack = await startStack();
    const base = new URL(stack?.url ?? target);
    target = base.origin;
    console.log(`conformance: ${target}`);
    ({ site, commit } = await runChecks(base, { local: args.local || isLoopback(base), onRow }));
    if (args.browser) (await browserRows(base)).forEach(onRow);
  } catch (error) {
    // A stack that did not start, most likely: the report says so instead of not existing.
    onRow(failed('run', 'completed', reason(error)));
  } finally {
    await stack?.stop();
  }

  const report = renderReport({
    target,
    site,
    commit,
    rows,
    startedAt: new Date(started).toISOString(),
    seconds: (Date.now() - started) / 1000,
  });
  if (args.report !== null) {
    mkdirSync(args.report, { recursive: true });
    writeFileSync(join(args.report, 'report.json'), report.json);
    writeFileSync(join(args.report, 'report.md'), report.markdown);
    console.log(`conformance: report in ${args.report}`);
  }
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, report.markdown);

  const code = exitCodeFor(rows);
  const failures = rows.filter((row) => row.status === 'fail').length;
  console.log(
    code === 0
      ? `conformance: ${String(rows.length)} checks, no failures`
      : `conformance: ${String(failures)} of ${String(rows.length)} checks failed`,
  );
  return code;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main();
  } catch (error) {
    console.error(reason(error));
    code = 2;
  }
  // The stack's child processes are gone by now; nothing else should hold the process open.
  process.exit(code);
}
