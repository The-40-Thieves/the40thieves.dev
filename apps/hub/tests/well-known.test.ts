import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

/**
 * P3-S3: the site-wide discovery files. `/.well-known/ai-catalog.json` is how a client that
 * knows only the domain finds the hub's MCP Server Card (served by the `mcp` Worker at
 * `<endpoint>/server-card`); `security.txt` follows RFC 9116.
 */
const dist = 'dist/client';
const SITE = 'https://the40thieves.dev';

test('ai-catalog.json is a minimal AI Catalog whose one entry is the hub server card', () => {
  const catalog: unknown = JSON.parse(readFileSync(`${dist}/.well-known/ai-catalog.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, 'utf8')) as {
    mcp: { endpoint: string };
  };
  expect(manifest.mcp.endpoint).toBe(`${SITE}/mcp`);
  expect(catalog).toEqual({
    specVersion: '1.0',
    entries: [
      {
        identifier: 'urn:air:the40thieves.dev:mcp:the40thieves-dev',
        type: 'application/mcp-server-card+json',
        // The card sits at the streamable HTTP endpoint plus /server-card (SEP-2127).
        url: `${manifest.mcp.endpoint}/server-card`,
      },
    ],
  });
});

test('_headers types the catalog, opens it to any origin and caches it for an hour', () => {
  const headers = readFileSync(`${dist}/_headers`, 'utf8');
  expect(headers).toContain(
    [
      '',
      '/.well-known/ai-catalog.json',
      '  Content-Type: application/ai-catalog+json',
      '  Access-Control-Allow-Origin: *',
      '  Cache-Control: public, max-age=3600',
      '',
    ].join('\n'),
  );
});

test('security.txt carries Contact, a dated Expires and its own Canonical URL', () => {
  const text = readFileSync(`${dist}/.well-known/security.txt`, 'utf8');
  const field = (name: string): string[] =>
    text
      .split('\n')
      .filter((line) => line.startsWith(`${name}: `))
      .map((line) => line.slice(name.length + 2).trim());
  expect(field('Canonical')).toEqual([`${SITE}/.well-known/security.txt`]);
  expect(field('Contact')).toEqual(['mailto:security@the40thieves.dev']);
  const expires = field('Expires');
  expect(expires).toHaveLength(1);
  expect(Number.isNaN(Date.parse(expires[0] ?? ''))).toBe(false);
});
