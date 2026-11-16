import { expect, test } from 'vitest';

import {
  exitCodeFor,
  parseConformanceArgs,
  playwrightSummary,
  renderReport,
} from '../scripts/conformance.ts';
import type { CheckRow } from '../scripts/lib/conformance-checks.ts';

// P3-S5: the runner's own parts. What each check does is in conformance-checks.test.ts.

test('exactly one target: a local stack or a URL', () => {
  expect(parseConformanceArgs(['--local'])).toEqual({
    url: null,
    local: true,
    browser: false,
    report: null,
  });
  const live = parseConformanceArgs(['--url', 'https://the40thieves.dev/', '--report', 'out']);
  expect(live.url?.href).toBe('https://the40thieves.dev/');
  expect(live).toMatchObject({ local: false, browser: false, report: 'out' });
  // An endpoint is as good as its origin; a stack started by hand is a plain http localhost.
  expect(parseConformanceArgs(['--url', 'https://the40thieves.dev/mcp']).url?.href).toBe(
    'https://the40thieves.dev/',
  );
  expect(parseConformanceArgs(['--url', 'http://127.0.0.1:8790', '--browser'])).toMatchObject({
    browser: true,
  });
  expect(() => parseConformanceArgs([])).toThrow(/--local or --url/);
  expect(() => parseConformanceArgs(['--local', '--url', 'https://the40thieves.dev'])).toThrow(
    /--local or --url/,
  );
  expect(() => parseConformanceArgs(['--url', 'http://the40thieves.dev'])).toThrow(/https/);
  expect(() => parseConformanceArgs(['--url', 'nope'])).toThrow(/URL/);
});

const rows: CheckRow[] = [
  { group: 'protocol', check: 'discover', status: 'pass', detail: '2026-07-28' },
  { group: 'twins', check: '/codecalc.md', status: 'fail', detail: 'answered 200 text/html' },
  { group: 'protocol', check: 'tools/list', status: 'pass', detail: '9 tools' },
  { group: 'rate limit', check: 'burst', status: 'skip', detail: 'not a local | stack\nat all' },
];
const run = {
  target: 'http://127.0.0.1:8790',
  site: 'https://the40thieves.dev',
  commit: 'abc123',
  rows,
  startedAt: '2026-11-09T12:00:00.000Z',
  seconds: 12.34,
};

test('any failed row fails the run; skips do not', () => {
  expect(exitCodeFor(rows)).toBe(1);
  expect(exitCodeFor(rows.filter((row) => row.status !== 'fail'))).toBe(0);
  expect(exitCodeFor([])).toBe(1);
});

test('the JSON report carries the run and a count of each result', () => {
  const report = JSON.parse(renderReport(run).json) as Record<string, unknown>;
  expect(report).toEqual({
    target: run.target,
    site: run.site,
    commit: run.commit,
    startedAt: run.startedAt,
    seconds: 12.3,
    summary: { pass: 2, fail: 1, skip: 1 },
    rows,
  });
});

test('the Markdown report leads with the count and the failures, then one table per group', () => {
  const { markdown } = renderReport(run);
  expect(markdown.startsWith('# Agent-surface conformance\n')).toBe(true);
  expect(markdown).toContain('**1 failed**, 2 passed, 1 skipped in 12.3 s');
  expect(markdown).toContain('- Target: http://127.0.0.1:8790');
  expect(markdown).toContain('- Site: https://the40thieves.dev');
  expect(markdown).toContain('- Commit: abc123');
  // Groups in the order they first ran, rows in the order they ran.
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  expect(headings).toEqual(['Failed', 'protocol', 'twins', 'rate limit']);
  expect(markdown).toContain('| twins | /codecalc.md | answered 200 text/html |');
  expect(markdown).toContain('| discover | pass | 2026-07-28 |\n| tools/list | pass | 9 tools |');
  // A pipe or a line break in a detail must not break the table.
  expect(markdown).toContain('| burst | skip | not a local \\| stack at all |');
});

test('a detail that looks like HTML is shown in the report, not rendered', () => {
  const { markdown } = renderReport({
    ...run,
    rows: [
      {
        group: 'twins',
        check: '/x.md',
        status: 'fail',
        detail: 'the body starts <!doctype html> & goes on',
      },
    ],
  });
  expect(markdown).toContain('| /x.md | fail | the body starts &lt;!doctype html> &amp; goes on |');
});

test('the browser row quotes the counts Playwright printed', () => {
  expect(
    playwrightSummary(
      'Running 1 test using 1 worker\n  ok 1 [chromium] › page-tools.spec.ts:17:1 › x (2.1s)\n\n  1 passed (3.4s)\n',
    ),
  ).toBe('1 passed (3.4s)');
  expect(
    playwrightSummary('  1 failed\n    [chromium] › x\n  2 passed (9.9s)\nError: ERR_PNPM\n'),
  ).toBe('1 failed, 2 passed (9.9s)');
  // No count at all: whatever was said last, or that nothing was.
  expect(playwrightSummary('Error: No tests found\n\n')).toBe('Error: No tests found');
  expect(playwrightSummary('')).toBe('no output');
});

test('a clean run has no Failed section and says so in one line', () => {
  const clean = renderReport({
    ...run,
    commit: null,
    rows: rows.filter((row) => row.status === 'pass'),
  });
  expect(clean.markdown).toContain('**2 passed**, 0 failed, 0 skipped');
  expect(clean.markdown).not.toContain('## Failed');
  expect(clean.markdown).toContain('- Commit: unknown');
  // Nothing checked is not a pass, and the report does not call it one.
  expect(renderReport({ ...run, rows: [] }).markdown).toContain('**No check ran**');
});
