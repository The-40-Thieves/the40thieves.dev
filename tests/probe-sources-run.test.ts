import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sourcesFileSchema } from '@the40thieves/schemas';
import { afterEach, expect, test } from 'vitest';

import { PROBE_ORIGIN, type UpstreamSource } from '../scripts/lib/probe-sources.ts';
import {
  parseProbeArgs,
  runProbe,
  type ProbeHost,
  type ProbeOptions,
  type Registry,
} from '../scripts/probe-sources.ts';

// The orchestrator with a fake host: no clone, no install, no network. Six sources cover the
// shapes the real registry has: a keyless REST source, a keyed one whose header and JSON body need
// a preflight, a remote MCP source (never searched), an RSS source whose adapter fails before
// fetching, one that always fails and one whose search never settles.

const COMMIT = '0be8f2c3014380f61a7a102406fb61e4a5c61f5a';

const sources: UpstreamSource[] = [
  {
    name: 'alpha',
    description: 'Alpha search.',
    kind: 'rest',
    cluster: 'academic',
    freshness: 'daily',
    homepage: 'https://alpha.example/',
  },
  {
    name: 'bravo',
    description: 'Bravo news.',
    kind: 'rest',
    cluster: 'news_global',
    freshness: 'realtime',
    homepage: 'https://bravo.example/',
    auth: { type: 'header', env: 'BRAVO_KEY', header: 'X-Api-Key' },
    pacing: { dailyCap: 100 },
    optionalEnv: ['GITHUB_TOKEN'],
  },
  {
    name: 'charlie',
    description: 'Charlie via MCP.',
    kind: 'mcp',
    cluster: 'web',
    freshness: 'realtime',
    homepage: 'https://charlie.example/',
  },
  {
    name: 'delta',
    description: 'Delta feed.',
    kind: 'rss',
    cluster: 'news_regional',
    freshness: 'realtime',
    homepage: 'https://delta.example/',
  },
  {
    name: 'foxtrot',
    description: 'Foxtrot, always down.',
    kind: 'rest',
    cluster: 'web',
    freshness: 'daily',
    homepage: 'https://foxtrot.example/',
  },
  {
    name: 'golf',
    description: 'Golf, never answers.',
    kind: 'rest',
    cluster: 'web',
    freshness: 'daily',
    homepage: 'https://golf.example/',
  },
];

interface Seen {
  url: string;
  method: string;
  origin: string | null;
  requestHeaders: string | null;
}

function fakeHost(dir: string, over: Partial<ProbeHost> = {}) {
  const seen: Seen[] = [];
  const log: string[] = [];
  const searched: string[] = [];
  const registry: Registry = {
    list: () => sources,
    async search(name, query, limit) {
      searched.push(name);
      expect(query).toBe('history of science');
      expect(limit).toBe(2);
      if (name === 'alpha') {
        await globalThis.fetch('https://api.alpha.example/search?q=x', {
          headers: { accept: 'application/json' },
        });
        return [1, 2];
      }
      if (name === 'bravo') {
        expect(process.env.BRAVO_KEY).toBe('the40thieves-probe');
        expect(process.env.GITHUB_TOKEN).toBeUndefined();
        const res = await globalThis.fetch('https://api.bravo.example/v1?q=x', {
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': process.env.BRAVO_KEY ?? '',
          },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${String(res.status)}, url: https://api.bravo.example/v1?q=x`);
        }
        return [];
      }
      if (name === 'delta') {
        // Down on the first attempt, up on the retry: the feed answers without CORS headers.
        if (searched.filter((n) => n === 'delta').length === 1) throw new TypeError('fetch failed');
        await globalThis.fetch('https://feeds.delta.example/rss.xml');
        return [1];
      }
      if (name === 'foxtrot') throw new TypeError('fetch failed');
      // A hung adapter: the per-source timeout is the only thing that ends this search.
      if (name === 'golf') return new Promise<unknown[]>(() => {});
      throw new Error(`unexpected search for ${name}`);
    },
  };
  function respond(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Response {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    seen.push({
      url,
      method,
      origin: headers.get('origin'),
      requestHeaders: headers.get('access-control-request-headers'),
    });
    if (url.startsWith('https://api.alpha.example/')) {
      return new Response('{}', { status: 200, headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.startsWith('https://feeds.delta.example/')) {
      return new Response('<rss/>', { status: 200 });
    }
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'x-api-key, accept, content-type',
        },
      });
    }
    return new Response('unauthorized', {
      status: 401,
      headers: { 'access-control-allow-origin': '*' },
    });
  }
  const host: ProbeHost = {
    prepare: () => Promise.resolve({ dir, commit: COMMIT }),
    load: () => Promise.resolve(registry),
    fetch: (input, init) => Promise.resolve(respond(input, init)),
    log: (line) => {
      log.push(line);
    },
    cleanup: () => {},
    ...over,
  };
  return { host, seen, log, searched };
}

function options(dir: string, over: Partial<ProbeOptions> = {}): ProbeOptions {
  return {
    ref: 'main',
    out: join(dir, 'sources.json'),
    check: false,
    only: null,
    concurrency: 6,
    timeoutMs: 200,
    maxFailed: 25,
    ...over,
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-sources-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('parseProbeArgs: defaults and flags', () => {
  expect(parseProbeArgs([])).toEqual({
    ref: 'main',
    out: 'data/sources.json',
    check: false,
    only: null,
    concurrency: 6,
    timeoutMs: 25_000,
    maxFailed: 25,
  });
  expect(
    parseProbeArgs([
      '--ref',
      COMMIT,
      '--check',
      '--only',
      'arxiv',
      '--out',
      'tmp/arxiv.json',
      '--concurrency',
      '2',
      '--timeout',
      '500',
      '--max-failed',
      '3',
    ]),
  ).toEqual({
    ref: COMMIT,
    out: 'tmp/arxiv.json',
    check: true,
    only: 'arxiv',
    concurrency: 2,
    timeoutMs: 500,
    maxFailed: 3,
  });
  // --only writes a one-source file, which must never land on the committed matrix by default.
  expect(() => parseProbeArgs(['--only', 'arxiv'])).toThrow(/--out/);
});

test('runProbe writes a valid file with one route per source and restores fetch and env', async () => {
  const dir = tempDir();
  const { host, seen, searched } = fakeHost(dir);
  const originalFetch = globalThis.fetch;
  delete process.env.BRAVO_KEY;

  const started = Date.now();
  const code = await runProbe(options(dir), host);
  const elapsed = Date.now() - started;

  expect(code).toBe(0);
  // golf never settles: two attempts bounded by the 200 ms per-source timeout, not the suite's.
  expect(elapsed).toBeLessThan(1500);
  expect(globalThis.fetch).toBe(originalFetch);
  expect(process.env.BRAVO_KEY).toBeUndefined();
  // A source that failed without a request is tried once more after the others; one retry only.
  expect([...searched].sort()).toEqual([
    'alpha',
    'bravo',
    'delta',
    'delta',
    'foxtrot',
    'foxtrot',
    'golf',
    'golf',
  ]);
  const file = sourcesFileSchema.parse(JSON.parse(readFileSync(options(dir).out, 'utf8')));
  expect(file.upstream).toEqual({
    repo: 'The-40-Thieves/alexandria-mcp',
    commit: COMMIT,
    sources: 6,
  });
  const byName = Object.fromEntries(file.sources.map((s) => [s.name, s]));
  expect(byName.alpha).toMatchObject({
    route: 'browser-direct',
    cors: 'open',
    hosts: ['api.alpha.example'],
    key: null,
    probe: { status: 'ok', detail: null },
  });
  expect(byName.bravo).toMatchObject({
    route: 'browser-direct',
    cors: 'open',
    hosts: ['api.bravo.example'],
    key: { env: 'BRAVO_KEY', type: 'header', daily_cap: 100 },
    probe: { status: 'ok', detail: 'HTTP 401' },
  });
  expect(byName.charlie).toMatchObject({
    route: 'mcp-only',
    cors: 'unknown',
    hosts: [],
    probe: { status: 'skipped', detail: null },
  });
  expect(byName.delta).toMatchObject({
    route: 'visitor-key-relay',
    cors: 'closed',
    hosts: ['feeds.delta.example'],
    probe: { status: 'ok', detail: null },
  });
  expect(byName.foxtrot).toMatchObject({
    route: 'visitor-key-relay',
    cors: 'unknown',
    hosts: [],
    probe: { status: 'failed', detail: 'TypeError: fetch failed' },
  });
  expect(byName.golf).toMatchObject({
    route: 'visitor-key-relay',
    cors: 'unknown',
    hosts: [],
    probe: { status: 'failed', detail: 'timeout' },
  });
  expect(file.routes).toEqual({
    'browser-direct': 2,
    'visitor-key-relay': 3,
    'quota-relay': 0,
    'mcp-only': 1,
  });
  // Every request carried the probe origin; bravo's non-simple headers (the key header and a JSON
  // content-type, which is not safelisted) earned one preflight naming both.
  expect(seen.every((s) => s.origin === PROBE_ORIGIN)).toBe(true);
  const preflights = seen.filter((s) => s.method === 'OPTIONS');
  expect(preflights).toHaveLength(1);
  expect(preflights[0]?.url.startsWith('https://api.bravo.example/')).toBe(true);
  expect(preflights[0]?.requestHeaders).toBe('content-type, x-api-key');
  // Nothing written says which URL was called or what the placeholder key was.
  const text = readFileSync(options(dir).out, 'utf8');
  expect(text).not.toContain('?q=');
  expect(text).not.toContain('the40thieves-probe');
});

test('--check matches a fresh file and refuses a stale one without rewriting it', async () => {
  const dir = tempDir();
  const { host, log } = fakeHost(dir);
  const out = options(dir).out;
  expect(await runProbe(options(dir), host)).toBe(0);
  const written = statSync(out).mtimeMs;

  expect(await runProbe(options(dir, { check: true }), host)).toBe(0);
  expect(statSync(out).mtimeMs).toBe(written);

  const stale = sourcesFileSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
  stale.sources = stale.sources.filter((s) => s.name !== 'bravo');
  stale.upstream.sources = 5;
  stale.routes['browser-direct'] = 1;
  const alphaStale = stale.sources.find((s) => s.name === 'alpha');
  if (alphaStale) alphaStale.cors = 'closed';
  const staleText = `${JSON.stringify(stale, null, 2)}\n`;
  writeFileSync(out, staleText);
  expect(await runProbe(options(dir, { check: true }), host)).toBe(1);
  expect(readFileSync(out, 'utf8')).toBe(staleText);
  // The difference is reported per source, not as a positional line diff.
  expect(log).toContain('+ bravo: added (browser-direct)');
  expect(log).toContain('~ alpha: cors closed -> open');
});

test('writing over an existing file logs what changed per source, for the weekly PR body', async () => {
  const dir = tempDir();
  const { host, log } = fakeHost(dir);
  const out = options(dir).out;
  expect(await runProbe(options(dir), host)).toBe(0);
  const stale = sourcesFileSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
  const alphaStale = stale.sources.find((s) => s.name === 'alpha');
  if (alphaStale) alphaStale.cors = 'closed';
  writeFileSync(out, `${JSON.stringify(stale, null, 2)}\n`);
  log.splice(0);

  expect(await runProbe(options(dir), host)).toBe(0);
  expect(log).toContain('~ alpha: cors closed -> open');
  expect(log.filter((line) => /^[~+-] /.test(line))).toHaveLength(1);
  // An unchanged file logs no change lines at all.
  log.splice(0);
  expect(await runProbe(options(dir), host)).toBe(0);
  expect(log.filter((line) => /^[~+-] /.test(line))).toEqual([]);
});

test('too many failed sources is exit 2 and writes nothing: a bad network must not propose a demotion', async () => {
  const dir = tempDir();
  const { host, log } = fakeHost(dir);
  // foxtrot and golf fail every run; a ceiling of one failure is exceeded.
  expect(await runProbe(options(dir, { maxFailed: 1 }), host)).toBe(2);
  expect(() => statSync(options(dir).out)).toThrow();
  expect(log.some((line) => line.includes('2 sources failed') && line.includes('1'))).toBe(true);
  // At the ceiling itself the file is written.
  expect(await runProbe(options(dir, { maxFailed: 2 }), host)).toBe(0);
  expect(() => statSync(options(dir).out)).not.toThrow();
});

test('a clone or install that fails is exit 125 and writes nothing', async () => {
  const dir = tempDir();
  const { host } = fakeHost(dir, {
    prepare: () => Promise.reject(new Error('npm ci failed')),
  });
  expect(await runProbe(options(dir), host)).toBe(125);
  expect(() => statSync(options(dir).out)).toThrow();
});

test('--only probes one source and still writes a file that validates', async () => {
  const dir = tempDir();
  const { host, searched } = fakeHost(dir);
  expect(await runProbe(options(dir, { only: 'alpha' }), host)).toBe(0);
  expect(searched).toEqual(['alpha']);
  const file = sourcesFileSchema.parse(JSON.parse(readFileSync(options(dir).out, 'utf8')));
  expect(file.sources.map((s) => s.name)).toEqual(['alpha']);
});
