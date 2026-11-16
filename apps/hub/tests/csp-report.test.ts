import { afterEach, expect, test, vi } from 'vitest';

import { MAX_CSP_REPORT_BYTES, parseCspReports } from '../src/lib/csp-report.ts';
import { ALL, POST } from '../src/pages/csp-report.ts';

// Browsers deliver CSP violations in two shapes: the legacy `report-uri` POST
// (`application/csp-report`, one report under "csp-report") and the Reporting API batch
// (`application/reports+json`, an array of typed reports). The endpoint accepts both, keeps
// only what identifies the violation, and writes one log line per violation for Workers Logs.

const legacy = {
  'csp-report': {
    'document-uri': 'https://the40thieves.dev/healthz',
    'effective-directive': 'script-src',
    'violated-directive': 'script-src',
    'blocked-uri': 'https://evil.example/x.js',
    disposition: 'report',
    'source-file': 'https://the40thieves.dev/healthz',
    'line-number': 7,
    'original-policy': "default-src 'self'; script-src 'self'",
  },
};

const batch = [
  {
    type: 'csp-violation',
    age: 12,
    url: 'https://the40thieves.dev/healthz',
    user_agent: 'x',
    body: {
      documentURL: 'https://the40thieves.dev/healthz',
      effectiveDirective: 'style-src',
      blockedURL: 'inline',
      disposition: 'report',
      sourceFile: 'https://the40thieves.dev/healthz',
      lineNumber: 3,
      originalPolicy: "default-src 'self'",
    },
  },
  { type: 'deprecation', age: 1, url: 'https://the40thieves.dev/', user_agent: 'x', body: {} },
];

test('parseCspReports reads the legacy report-uri shape', () => {
  expect(parseCspReports('application/csp-report', JSON.stringify(legacy))).toEqual([
    {
      documentUrl: 'https://the40thieves.dev/healthz',
      effectiveDirective: 'script-src',
      blockedUrl: 'https://evil.example/x.js',
      disposition: 'report',
      sourceFile: 'https://the40thieves.dev/healthz',
      lineNumber: 7,
    },
  ]);
});

test('parseCspReports reads a Reporting API batch and keeps only csp-violation entries', () => {
  expect(parseCspReports('application/reports+json; charset=utf-8', JSON.stringify(batch))).toEqual(
    [
      {
        documentUrl: 'https://the40thieves.dev/healthz',
        effectiveDirective: 'style-src',
        blockedUrl: 'inline',
        disposition: 'report',
        sourceFile: 'https://the40thieves.dev/healthz',
        lineNumber: 3,
      },
    ],
  );
});

test('parseCspReports refuses other content types, bad JSON and the wrong shape', () => {
  expect(parseCspReports('text/plain', JSON.stringify(legacy))).toBeNull();
  expect(parseCspReports(null, JSON.stringify(legacy))).toBeNull();
  expect(parseCspReports('application/csp-report', '{not json')).toBeNull();
  expect(parseCspReports('application/csp-report', '[]')).toBeNull();
  expect(parseCspReports('application/reports+json', '{}')).toBeNull();
});

test('parseCspReports truncates long fields and tolerates missing ones', () => {
  const long = 'a'.repeat(2000);
  const reports = parseCspReports(
    'application/csp-report',
    JSON.stringify({ 'csp-report': { 'blocked-uri': long } }),
  );
  expect(reports).toHaveLength(1);
  expect(reports?.[0]?.blockedUrl?.length).toBe(256);
  expect(reports?.[0]?.documentUrl).toBeUndefined();
  expect(reports?.[0]?.lineNumber).toBeUndefined();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: string, contentType: string, extra: Record<string, string> = {}): Request {
  return new Request('https://the40thieves.dev/csp-report', {
    method: 'POST',
    headers: { 'content-type': contentType, ...extra },
    body,
  });
}

test('POST /csp-report answers a synthetic report with 204 and logs one line per violation', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const response = await POST({
    request: post(JSON.stringify(batch), 'application/reports+json'),
  } as never);
  expect(response.status).toBe(204);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(warn).toHaveBeenCalledTimes(1);
  const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
  expect(line['event']).toBe('csp-report');
  expect(line['effectiveDirective']).toBe('style-src');
  expect(line['blockedUrl']).toBe('inline');
});

test('POST /csp-report rejects a malformed body with 400 and logs nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const response = await POST({ request: post('nope', 'application/csp-report') } as never);
  expect(response.status).toBe(400);
  expect(warn).not.toHaveBeenCalled();
});

test('POST /csp-report refuses an oversized body with 413 before reading it', async () => {
  const declared = post('{}', 'application/csp-report', {
    'content-length': String(MAX_CSP_REPORT_BYTES + 1),
  });
  expect((await POST({ request: declared } as never)).status).toBe(413);
  const actual = post('x'.repeat(MAX_CSP_REPORT_BYTES + 1), 'application/csp-report');
  expect((await POST({ request: actual } as never)).status).toBe(413);
});

test('other methods on /csp-report get 405 with an Allow header', async () => {
  const response = await ALL({
    request: new Request('https://the40thieves.dev/csp-report', { method: 'GET' }),
  } as never);
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('POST');
});
