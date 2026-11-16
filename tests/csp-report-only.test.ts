import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { CSP_REPORT_GROUP, CSP_REPORT_PATH, reportOnlyPolicy } from '../scripts/lib/csp.ts';
import { loadPolicy, repoRoot } from '../scripts/lib/policy.ts';

// The hashed CSP lives in a <meta> on prerendered pages (Astro `security.csp`), which cannot
// report. On-demand responses get a Content-Security-Policy-Report-Only header instead: the same
// directive file plus host-only script and style sources, reporting to the Worker's own endpoint.
// The policy file is what the middleware and the audits read; this test keeps its value derived
// from security/csp.directives.json rather than hand-maintained.

const directives = (
  JSON.parse(readFileSync(resolve(repoRoot, 'security/csp.directives.json'), 'utf8')) as {
    directives: string[];
  }
).directives;

test('reportOnlyPolicy adds script, style and reporting directives and drops the upgrade one', () => {
  const value = reportOnlyPolicy([
    "default-src 'self'",
    'upgrade-insecure-requests',
    "object-src 'none'",
  ]);
  expect(value).toBe(
    "default-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; " +
      "frame-ancestors 'none'; report-uri /csp-report; report-to csp-endpoint",
  );
});

test('the policy file carries the derived report-only header and its endpoint, ssr class only', () => {
  const policy = loadPolicy();
  const reportOnly = policy.headers.find(
    (rule) => rule.name === 'Content-Security-Policy-Report-Only',
  );
  const endpoints = policy.headers.find((rule) => rule.name === 'Reporting-Endpoints');
  expect(reportOnly?.value).toBe(reportOnlyPolicy(directives));
  expect(reportOnly?.classes).toEqual(['ssr']);
  expect(endpoints?.value).toBe(`${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  expect(endpoints?.classes).toEqual(['ssr']);
});

test('the enforced frame-ancestors header stays as it was on every class', () => {
  const csp = loadPolicy().headers.find((rule) => rule.name === 'Content-Security-Policy');
  expect(csp?.value).toBe("frame-ancestors 'none'");
  // The mcp class (P3-S1) carries the same enforced header; only the report-only pair is ssr-only.
  expect(csp?.classes).toEqual(['static', 'ssr', 'mcp']);
});
