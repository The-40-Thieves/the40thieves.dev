import { readFileSync } from 'node:fs';

import type { BuildInfo } from '@the40thieves/manifest';
import { expect, test } from 'vitest';

import policy from '../../../security/headers.policy.json' with { type: 'json' };
import { tryLd } from '../src/lib/json-ld.ts';
import { CONNECT_ORIGINS } from '../src/lib/try/relay.ts';
import { TRY_SOURCES } from '../src/lib/try/sources.ts';
import { tryTwin } from '../src/lib/twins.ts';

// The try page (P4-S4): its header policy, its built <meta> policy and its twin all name
// the same hosts, and the page carries no analytics. The dist checks read the build the
// workspace test run follows (as tests/build-output.test.ts does).

const build: BuildInfo = {
  generatedAt: '2026-11-15T00:00:00.000Z',
  commit: 'c'.repeat(40),
  site: 'https://the40thieves.dev',
};

const PAGE = '/alexandria/try/';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] !== '')
      .map(([name, ...values]) => [name, values]),
  );
}

function headerRule(name: string): string {
  const rule = policy.headers.find((r) => r.name === name && 'path' in r && r.path === PAGE);
  if (rule === undefined) throw new Error(`no ${name} rule for ${PAGE}`);
  return rule.value;
}

test('every source host is a connect origin, and the browser-direct ones are called as-is', () => {
  for (const source of TRY_SOURCES) {
    if (source.route === 'browser-direct') {
      expect(CONNECT_ORIGINS).toContain(`https://${source.host}`);
    } else {
      expect(CONNECT_ORIGINS, source.name).not.toContain(`https://${source.host}`);
    }
  }
  expect(CONNECT_ORIGINS).toContain('https://relay.the40thieves.dev');
});

test('the page header policy enforces exactly those origins, with no PostHog, and reports', () => {
  const csp = directives(headerRule('Content-Security-Policy'));
  expect(csp.get('connect-src')).toEqual(["'self'", ...CONNECT_ORIGINS]);
  expect(csp.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
  expect(csp.get('report-uri')).toEqual(['/csp-report']);
  expect(csp.get('report-to')).toEqual(['csp-endpoint']);
  // Script and style sources stay with the hashed meta; the header must not loosen or fight it.
  expect(csp.has('script-src')).toBe(false);
  expect(csp.has('default-src')).toBe(false);
  expect(headerRule('Reporting-Endpoints')).toBe('csp-endpoint="/csp-report"');
});

test('the built page: meta policy allows the origins and Turnstile, and no page-view script', () => {
  const html = readFileSync(`dist/client${PAGE}index.html`, 'utf8');
  const meta = /<meta http-equiv="content-security-policy" content="([^"]+)"/i.exec(html)?.[1];
  expect(meta).toBeDefined();
  const csp = directives(meta ?? '');
  for (const origin of CONNECT_ORIGINS) expect(csp.get('connect-src')).toContain(origin);
  expect(csp.get('script-src')).toContain('https://challenges.cloudflare.com');
  expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  expect(csp.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
  expect(html).toContain('<link rel="manifest" href="/alexandria/try/manifest.webmanifest">');
  expect(html).toContain('<astro-island');
  // The page-view script reads POSTHOG_CAPTURE_URL; it must not be bundled into this page.
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    expect(readFileSync(`dist/client${src}`, 'utf8')).not.toContain('i.posthog.com');
  }
});

test('the manifest is scoped to the page', () => {
  const manifest = JSON.parse(
    readFileSync('public/alexandria/try/manifest.webmanifest', 'utf8'),
  ) as Record<string, unknown>;
  expect(manifest['scope']).toBe(PAGE);
  expect(manifest['start_url']).toBe(PAGE);
});

test('the twin lists every source with its route and the connect origins', () => {
  const twin = tryTwin(build);
  for (const source of TRY_SOURCES) {
    expect(twin).toContain(
      `| ${source.label} (${source.name}) | ${source.route} | ${source.host} |`,
    );
  }
  for (const origin of CONNECT_ORIGINS) expect(twin).toContain(origin);
  expect(twin).toContain('HTML version: https://the40thieves.dev/alexandria/try/');
});

test('JSON-LD names a free web application at the page URL', () => {
  expect(tryLd(build)).toMatchObject({
    '@type': 'WebApplication',
    url: 'https://the40thieves.dev/alexandria/try/',
    isAccessibleForFree: true,
  });
});
