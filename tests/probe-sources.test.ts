import { expect, test } from 'vitest';

import {
  buildSourcesFile,
  corsVerdict,
  diffSourcesFiles,
  entryFor,
  isSimpleRequestHeader,
  keyFor,
  PROBE_ORIGIN,
  probeEnv,
  renderSourcesFile,
  routeFor,
  type Capture,
  type UpstreamSource,
} from '../scripts/lib/probe-sources.ts';

// The classification core of the alexandria source probe (P4-S1): upstream facts plus what
// the recorder saw become one entry with one route. Pure functions, so every rule is pinned here
// without a network.

const rest = (over: Partial<UpstreamSource> = {}): UpstreamSource => ({
  name: 'alpha',
  description: ' Alpha search.\nSecond line ',
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://alpha.example/',
  ...over,
});

const keyed = (over: Partial<UpstreamSource> = {}): UpstreamSource =>
  rest({
    name: 'bravo',
    auth: { type: 'header', env: 'BRAVO_KEY', header: 'X-Api-Key' },
    ...over,
  });

const capture = (over: Partial<Capture> = {}): Capture => ({
  host: 'api.alpha.example',
  requestHeaders: ['accept'],
  status: 200,
  acao: '*',
  preflight: null,
  ...over,
});

test('isSimpleRequestHeader: CORS-safelisted and browser-set headers need no preflight', () => {
  for (const name of ['accept', 'Accept', 'accept-language', 'user-agent']) {
    expect(isSimpleRequestHeader(name)).toBe(true);
  }
  expect(isSimpleRequestHeader('authorization')).toBe(false);
  expect(isSimpleRequestHeader('X-Api-Key')).toBe(false);
  // content-type is safelisted only with one of three values; a JSON body is a preflighted request.
  expect(isSimpleRequestHeader('content-type', 'text/plain')).toBe(true);
  expect(
    isSimpleRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8'),
  ).toBe(true);
  expect(isSimpleRequestHeader('content-type', 'multipart/form-data; boundary=x')).toBe(true);
  expect(isSimpleRequestHeader('content-type', 'application/json')).toBe(false);
  expect(isSimpleRequestHeader('content-type')).toBe(false);
});

test('corsVerdict: unknown without captures, open for * or the probe origin, closed otherwise', () => {
  expect(corsVerdict([])).toBe('unknown');
  expect(corsVerdict([capture()])).toBe('open');
  expect(corsVerdict([capture({ acao: PROBE_ORIGIN })])).toBe('open');
  expect(corsVerdict([capture({ acao: null })])).toBe('closed');
  expect(corsVerdict([capture({ acao: 'https://other.example' })])).toBe('closed');
  expect(corsVerdict([capture(), capture({ host: 'b.example', acao: null })])).toBe('closed');
});

test('corsVerdict: a non-simple header needs a preflight that allows the origin and the header', () => {
  const withAuth = { requestHeaders: ['accept', 'authorization'] };
  expect(corsVerdict([capture({ ...withAuth, preflight: null })])).toBe('closed');
  expect(
    corsVerdict([
      capture({ ...withAuth, preflight: { acao: '*', allowHeaders: 'Authorization, Accept' } }),
    ]),
  ).toBe('open');
  // The wildcard never covers Authorization (Fetch standard); it has to be listed by name.
  expect(corsVerdict([capture({ ...withAuth, preflight: { acao: '*', allowHeaders: '*' } })])).toBe(
    'closed',
  );
  expect(
    corsVerdict([
      capture({ ...withAuth, preflight: { acao: '*', allowHeaders: '*, authorization' } }),
    ]),
  ).toBe('open');
  const withApiKey = { requestHeaders: ['accept', 'x-api-key'] };
  expect(
    corsVerdict([capture({ ...withApiKey, preflight: { acao: '*', allowHeaders: '*' } })]),
  ).toBe('open');
  // A recorded content-type is one whose value was not safelisted: it needs the preflight too.
  const withJson = { requestHeaders: ['accept', 'content-type'] };
  expect(corsVerdict([capture({ ...withJson, preflight: null })])).toBe('closed');
  expect(
    corsVerdict([capture({ ...withJson, preflight: { acao: '*', allowHeaders: 'content-type' } })]),
  ).toBe('open');
  expect(
    corsVerdict([capture({ ...withAuth, preflight: { acao: '*', allowHeaders: 'accept' } })]),
  ).toBe('closed');
  expect(
    corsVerdict([capture({ ...withAuth, preflight: { acao: null, allowHeaders: '*' } })]),
  ).toBe('closed');
});

test('routeFor: mcp and scrape kinds stay MCP-only whatever the probe saw', () => {
  expect(routeFor(rest({ kind: 'mcp' }), 'open')).toBe('mcp-only');
  expect(routeFor(rest({ kind: 'scrape' }), 'closed')).toBe('mcp-only');
});

test('routeFor: an open origin is browser-direct, keyed or not', () => {
  expect(routeFor(rest(), 'open')).toBe('browser-direct');
  expect(routeFor(keyed(), 'open')).toBe('browser-direct');
});

test('routeFor: closed or unknown goes through the relay; a declared daily cap means quota relay', () => {
  expect(routeFor(rest(), 'closed')).toBe('visitor-key-relay');
  expect(routeFor(rest(), 'unknown')).toBe('visitor-key-relay');
  expect(routeFor(keyed(), 'closed')).toBe('visitor-key-relay');
  expect(routeFor(keyed({ pacing: { dailyCap: 900 } }), 'closed')).toBe('quota-relay');
  expect(routeFor(keyed({ pacing: { dailyCap: 900 } }), 'unknown')).toBe('quota-relay');
  expect(routeFor(rest({ pacing: { dailyCap: 25 } }), 'closed')).toBe('visitor-key-relay');
});

test('keyFor: absent or none auth is no key; otherwise env, type and the declared cap', () => {
  expect(keyFor(rest())).toBeNull();
  expect(keyFor(rest({ auth: { type: 'none' } }))).toBeNull();
  expect(keyFor(keyed())).toEqual({ env: 'BRAVO_KEY', type: 'header', daily_cap: null });
  expect(keyFor(keyed({ pacing: { dailyCap: 100 } }))).toEqual({
    env: 'BRAVO_KEY',
    type: 'header',
    daily_cap: 100,
  });
});

test('probeEnv: placeholders for every key env, optional envs cleared', () => {
  const env = probeEnv([
    keyed(),
    keyed({ name: 'charlie', auth: { type: 'query', env: 'CHARLIE_KEY', param: 'key' } }),
    rest({ optionalEnv: ['GITHUB_TOKEN', 'CONTACT_EMAIL'] }),
  ]);
  expect(env.set).toEqual({ BRAVO_KEY: 'the40thieves-probe', CHARLIE_KEY: 'the40thieves-probe' });
  expect(env.unset).toEqual(['CONTACT_EMAIL', 'GITHUB_TOKEN']);
});

test('entryFor: hosts sorted and deduplicated, terms from the homepage, description one line', () => {
  const entry = entryFor(
    rest(),
    [
      capture({ host: 'b.example' }),
      capture({ host: 'a.example' }),
      capture({ host: 'a.example', acao: null }),
    ],
    { status: 'ok', detail: null },
  );
  expect(entry.hosts).toEqual(['a.example', 'b.example']);
  expect(entry.cors).toBe('closed');
  expect(entry.route).toBe('visitor-key-relay');
  expect(entry.terms).toEqual({ url: 'https://alpha.example/', ingest: 'allowed' });
  expect(entry.description).toBe('Alpha search. Second line');
  expect(entry.key).toBeNull();
});

test('entryFor: a skipped kind has no hosts and an unknown verdict', () => {
  const entry = entryFor(rest({ kind: 'mcp', ingestPolicy: 'forbidden' }), [], {
    status: 'skipped',
    detail: null,
  });
  expect(entry).toMatchObject({ hosts: [], cors: 'unknown', route: 'mcp-only' });
  expect(entry.terms.ingest).toBe('forbidden');
});

test('buildSourcesFile: sorted, counted, validated', () => {
  const b = entryFor(keyed(), [capture({ host: 'api.bravo.example', acao: null })], {
    status: 'ok',
    detail: 'HTTP 401',
  });
  const a = entryFor(rest(), [capture()], { status: 'ok', detail: null });
  const file = buildSourcesFile([b, a], { commit: '0be8f2c3014380f61a7a102406fb61e4a5c61f5a' });
  expect(file.sources.map((s) => s.name)).toEqual(['alpha', 'bravo']);
  expect(file.routes).toEqual({
    'browser-direct': 1,
    'visitor-key-relay': 1,
    'quota-relay': 0,
    'mcp-only': 0,
  });
  expect(file.upstream).toEqual({
    repo: 'The-40-Thieves/alexandria-mcp',
    commit: '0be8f2c3014380f61a7a102406fb61e4a5c61f5a',
    sources: 2,
  });
  expect(file.origin).toBe(PROBE_ORIGIN);
  expect(() => buildSourcesFile([a, a], { commit: file.upstream.commit })).toThrow(/sorted|unique/);
});

test('diffSourcesFiles: per-source lines for added, removed and changed entries', () => {
  const a = entryFor(rest(), [capture()], { status: 'ok', detail: null });
  const b = entryFor(keyed(), [capture({ host: 'api.bravo.example', acao: null })], {
    status: 'ok',
    detail: 'HTTP 401',
  });
  const commit = '0be8f2c3014380f61a7a102406fb61e4a5c61f5a';
  const before = buildSourcesFile([a, b], { commit });
  const aChanged = entryFor(rest(), [capture({ acao: null })], {
    status: 'ok',
    detail: 'HTTP 429',
  });
  const c = entryFor(rest({ name: 'charlie', kind: 'mcp' }), [], {
    status: 'skipped',
    detail: null,
  });
  const after = buildSourcesFile([aChanged, c], { commit: 'f'.repeat(40) });
  expect(diffSourcesFiles(before, after)).toEqual([
    '~ upstream.commit 0be8f2c3014380f61a7a102406fb61e4a5c61f5a -> ffffffffffffffffffffffffffffffffffffffff',
    '~ alpha: cors open -> closed, route browser-direct -> visitor-key-relay, probe.detail null -> HTTP 429',
    '- bravo: removed (visitor-key-relay)',
    '+ charlie: added (mcp-only)',
  ]);
  expect(diffSourcesFiles(before, before)).toEqual([]);
  expect(diffSourcesFiles(null, after)).toEqual([
    '+ alpha: added (visitor-key-relay)',
    '+ charlie: added (mcp-only)',
  ]);
});

test('renderSourcesFile: two-space JSON, trailing newline, no timestamps', () => {
  const a = entryFor(rest(), [capture()], { status: 'ok', detail: null });
  const text = renderSourcesFile(
    buildSourcesFile([a], { commit: '0be8f2c3014380f61a7a102406fb61e4a5c61f5a' }),
  );
  expect(text.endsWith('}\n')).toBe(true);
  expect(text).toContain('\n  "version": 1,');
  expect(text).not.toMatch(/"(generated_at|probed_at|timestamp)"/);
});
