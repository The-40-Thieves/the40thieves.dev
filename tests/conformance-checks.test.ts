import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MCP_TOOL_NAMES, WEBMCP_TOOL_NAMES } from '@the40thieves/manifest';
import { type Manifest, manifestSchema } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import {
  type CheckRow,
  driftRows,
  type Fetched,
  fetchSurfaces,
  guarded,
  loadManifest,
  logged,
  originRows,
  rateLimitRows,
  rowsFromLog,
  servedPageTools,
  type Surfaces,
  twinRows,
  versionHeaderRows,
} from '../scripts/lib/conformance-checks.ts';

// P3-S5: each check reads one answer from a running stack and becomes one report row. The
// answers pinned here are the ones the `mcp` Worker gave in local workerd when the suite was
// written; `workers/mcp/tests/conformance.test.ts` runs the same checks against the Worker code.

const ENDPOINT = new URL('http://127.0.0.1:8790/mcp');
const SITE = 'https://the40thieves.dev';

interface Call {
  url: URL;
  method: string;
  headers: Headers;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch answered by `answer`; every call is recorded. */
function scripted(answer: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const reply = answer(call, calls.length);
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const statuses = (rows: CheckRow[]) => rows.map((row) => `${row.check}: ${row.status}`);
const TOOLS = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search_projects' }] } };
const REFUSED = { jsonrpc: '2.0', id: null, error: { code: -32020, message: 'Bad Request' } };

test('log lines become rows; anything else is not a row', () => {
  expect(
    rowsFromLog('protocol', [
      'ok discover: 2026-07-28',
      'FAIL tools/list: got a, b; manifest says a',
      'skip ai-catalog: a localhost endpoint has no hub in front of it',
      'mcp-smoke: no failures',
    ]),
  ).toEqual([
    { group: 'protocol', check: 'discover', status: 'pass', detail: '2026-07-28' },
    { group: 'protocol', check: 'tools/list', status: 'fail', detail: 'got a, b; manifest says a' },
    {
      group: 'protocol',
      check: 'ai-catalog',
      status: 'skip',
      detail: 'a localhost endpoint has no hub in front of it',
    },
  ]);
});

test('a group that throws is one failed row, with the reason', async () => {
  const rows = await guarded('twins', () => Promise.reject(new Error('socket hang up')));
  expect(rows).toEqual([
    { group: 'twins', check: 'ran', status: 'fail', detail: 'socket hang up' },
  ]);
  const fine: CheckRow[] = [{ group: 'twins', check: 'a', status: 'pass', detail: '' }];
  expect(await guarded('twins', () => Promise.resolve(fine))).toBe(fine);
});

/** The Worker's answers to the version-header requests, keyed by the header it was sent. */
function versionAnswer(call: Call): Reply {
  return call.headers.get('mcp-protocol-version') === '2026-07-28'
    ? { status: 200, body: TOOLS }
    : { status: 400, body: REFUSED };
}

test('the version header: a matching one is served, a missing or different one is a 400', async () => {
  const { fetchImpl, calls } = scripted(versionAnswer);
  const rows = await versionHeaderRows(ENDPOINT, fetchImpl);
  expect(statuses(rows)).toEqual(['matching: pass', 'absent: pass', 'mismatch: pass']);
  expect(rows.every((row) => row.group === 'version header')).toBe(true);
  expect(calls.map((call) => call.headers.get('mcp-protocol-version'))).toEqual([
    '2026-07-28',
    null,
    '2025-11-25',
  ]);
  // Every request is the page-style POST to the endpoint itself.
  expect(calls.every((call) => call.method === 'POST' && call.url.href === ENDPOINT.href)).toBe(
    true,
  );
});

test('the version header: a server that serves any header fails the two refusals', async () => {
  const lenient = scripted(() => ({ status: 200, body: TOOLS }));
  expect(statuses(await versionHeaderRows(ENDPOINT, lenient.fetchImpl))).toEqual([
    'matching: pass',
    'absent: fail',
    'mismatch: fail',
  ]);
  // A 400 that still carries a result is not a refusal either.
  const confused = scripted((call) =>
    call.headers.get('mcp-protocol-version') === '2026-07-28'
      ? { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }
      : { status: 400, body: TOOLS },
  );
  expect(statuses(await versionHeaderRows(ENDPOINT, confused.fetchImpl))).toEqual([
    'matching: fail',
    'absent: fail',
    'mismatch: fail',
  ]);
});

test('origin: a foreign browser Origin is refused and the site itself is served', async () => {
  const { fetchImpl, calls } = scripted((call) =>
    call.headers.get('origin') === SITE ? { status: 200, body: TOOLS } : { status: 403, body: {} },
  );
  expect(statuses(await originRows(ENDPOINT, SITE, fetchImpl))).toEqual([
    'foreign: pass',
    'site: pass',
  ]);
  expect(calls.map((call) => call.headers.get('origin'))).toEqual(['https://evil.example', SITE]);
  const open = scripted(() => ({ status: 200, body: TOOLS }));
  expect(statuses(await originRows(ENDPOINT, SITE, open.fetchImpl))).toEqual([
    'foreign: fail',
    'site: pass',
  ]);
});

const KEYS = { key: '2001:db8::a', otherKey: '2001:db8::b', retryKey: '2001:db8::c' };

/** A limiter that counts per `cf-connecting-ip`, refusing after `max`; healthz is never counted. */
function limited(max: number, retryAfter: string | null = '60') {
  const counts = new Map<string, number>();
  return scripted((call) => {
    if (call.url.pathname === '/mcp/healthz') return { status: 200, body: { ok: true } };
    const key = call.headers.get('cf-connecting-ip') ?? 'unknown';
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count <= max) return { status: 200, body: {} };
    return {
      status: 429,
      body: {},
      ...(retryAfter === null ? {} : { headers: { 'retry-after': retryAfter } }),
    };
  });
}

test('rate limit: 100 requests pass, the 101st is a 429 with Retry-After, per client', async () => {
  const { fetchImpl, calls } = limited(100);
  const rows = await rateLimitRows(ENDPOINT, { local: true, ...KEYS }, fetchImpl);
  expect(statuses(rows)).toEqual([
    'budget: pass',
    'refusal: pass',
    'per client: pass',
    'healthz: pass',
  ]);
  expect(calls).toHaveLength(103);
  expect(calls.slice(0, 101).every((call) => call.url.pathname === '/mcp/server-card')).toBe(true);
  expect(
    calls.slice(0, 101).every((call) => call.headers.get('cf-connecting-ip') === KEYS.key),
  ).toBe(true);
  expect(calls[101]?.headers.get('cf-connecting-ip')).toBe(KEYS.otherKey);
  expect(calls[102]?.url.pathname).toBe('/mcp/healthz');
  expect(calls[102]?.headers.get('cf-connecting-ip')).toBe(KEYS.key);
});

test('rate limit: a budget that is too small, too large or silent about the wait fails', async () => {
  const run = async (fetchImpl: typeof fetch) =>
    statuses(await rateLimitRows(ENDPOINT, { local: true, ...KEYS }, fetchImpl));
  const small = await rateLimitRows(ENDPOINT, { local: true, ...KEYS }, limited(56).fetchImpl);
  expect(small[0]).toMatchObject({ check: 'budget', status: 'fail' });
  expect(small[0]?.detail).toContain('request 57');
  expect(await run(limited(1000).fetchImpl)).toEqual([
    'budget: pass',
    'refusal: fail',
    'per client: pass',
    'healthz: pass',
  ]);
  expect(await run(limited(100, null).fetchImpl)).toContain('refusal: fail');
  expect(await run(limited(100, '5').fetchImpl)).toContain('refusal: fail');
});

// Local workerd counts in windows aligned to the wall clock: a burst that straddles the start of
// a minute is counted in two windows, so its 101st request is served and proves nothing.
test('rate limit: a burst that crosses a minute boundary is repeated once with a fresh client', async () => {
  const counts = new Map<string, number>();
  const { fetchImpl, calls } = scripted((call) => {
    if (call.url.pathname === '/mcp/healthz') return { status: 200, body: { ok: true } };
    const key = call.headers.get('cf-connecting-ip') ?? 'unknown';
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    // The first client's count was reset mid-burst: it is never refused.
    if (key === KEYS.key || count <= 100) return { status: 200, body: {} };
    return { status: 429, body: {}, headers: { 'retry-after': '60' } };
  });
  // 59.9 s when the first burst starts, 60.1 s when it ends; the clock then stays in that minute.
  const clock = [59_900, 60_100];
  const now = () => clock.shift() ?? 61_000;
  const rows = await rateLimitRows(ENDPOINT, { local: true, ...KEYS, now }, fetchImpl);
  expect(statuses(rows)).toEqual([
    'budget: pass',
    'refusal: pass',
    'per client: pass',
    'healthz: pass',
  ]);
  expect(rows[1]?.detail).toContain('second burst');
  const sentAs = (key: string) =>
    calls.filter((call) => call.headers.get('cf-connecting-ip') === key).length;
  expect(sentAs(KEYS.key)).toBe(101);
  // 101 again, then healthz for the client that really is over its budget.
  expect(sentAs(KEYS.retryKey)).toBe(102);
});

test('rate limit: a second burst that crosses a boundary too is judged as it stands, and says so', async () => {
  const { fetchImpl } = limited(1000);
  let tick = 0;
  const now = () => (tick++ % 2 === 0 ? 59_900 : 60_100);
  const rows = await rateLimitRows(ENDPOINT, { local: true, ...KEYS, now }, fetchImpl);
  expect(rows[1]).toMatchObject({ check: 'refusal', status: 'fail' });
  expect(rows[1]?.detail).toContain('crossed a minute boundary twice');
  // No third burst: the run says what happened instead of looping.
  expect(tick).toBe(4);
});

test('rate limit: against anything but a local stack the burst is skipped, not sent', async () => {
  const { fetchImpl, calls } = limited(100);
  const rows = await rateLimitRows(
    new URL('https://the40thieves.dev/mcp'),
    { local: false, ...KEYS },
    fetchImpl,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ group: 'rate limit', check: 'burst', status: 'skip' });
  expect(calls).toHaveLength(0);
});

// Twins and drift: the documents are fetched once, then judged twice, against the protocol of
// the twins (status, type, Link) and against the manifest contract the build is held to.
// The Worker's own fixture, read from disk: its helpers are typed for the Workers runtime.
const MANIFEST_JSON = readFileSync(
  resolve(import.meta.dirname, '../workers/mcp/tests/fixtures/manifest.json'),
  'utf8',
);
const manifest: Manifest = manifestSchema.parse(JSON.parse(MANIFEST_JSON) as unknown);
const BASE = new URL('http://127.0.0.1:8790');
const twinOf = (page: string) => (page === '/' ? '/index.md' : `${page.slice(0, -1)}.md`);

interface Doc {
  status?: number;
  type?: string;
  text?: string;
  link?: string | null;
  location?: string;
}

/** The site as the stack serves it: `/404/` redirects to `/404`, everything else answers. */
function goodSite(): Map<string, Doc> {
  const site = new Map<string, Doc>([
    ['/manifest.json', { type: 'application/json', text: MANIFEST_JSON }],
    ['/llms.txt', { type: 'text/plain; charset=utf-8', text: '# The 40 Thieves\n' }],
    ['/llms-full.txt', { type: 'text/plain; charset=utf-8', text: '# full\n' }],
    ['/AGENTS.md', { type: 'text/markdown; charset=utf-8', text: '# AGENTS.md\n' }],
    ['/404', { type: 'text/html; charset=utf-8', text: '<h1>Not found</h1>' }],
  ]);
  for (const page of manifest.pages) {
    const link = `<${twinOf(page)}>; rel="alternate"; type="text/markdown"`;
    site.set(
      page,
      page === '/404/'
        ? { status: 307, location: '/404', link }
        : { type: 'text/html; charset=utf-8', text: `<h1>${page}</h1>`, link },
    );
    site.set(twinOf(page), { type: 'text/markdown; charset=utf-8', text: `# ${page}\n` });
  }
  return site;
}

function serve(site: Map<string, Doc>) {
  const requests: { path: string; redirect: RequestInit['redirect'] }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ path: pathname, redirect: init?.redirect });
    const doc = site.get(pathname);
    if (doc === undefined) {
      return Promise.resolve(
        new Response('<h1>Not found</h1>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
      );
    }
    const headers = new Headers();
    if (doc.type !== undefined) headers.set('content-type', doc.type);
    if (doc.link != null) headers.set('link', doc.link);
    if (doc.location !== undefined) headers.set('location', doc.location);
    const status = doc.status ?? 200;
    return Promise.resolve(
      new Response(status >= 300 && status < 400 ? null : (doc.text ?? ''), { status, headers }),
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const failed = (rows: CheckRow[]) =>
  rows.filter((row) => row.status !== 'pass').map((row) => row.check);

test('the manifest is read from the stack and has to be a manifest', async () => {
  expect((await loadManifest(BASE, serve(goodSite()).fetchImpl)).site).toBe(
    'https://the40thieves.dev',
  );
  const missing = goodSite();
  missing.delete('/manifest.json');
  await expect(loadManifest(BASE, serve(missing).fetchImpl)).rejects.toThrow(/manifest\.json/);
  const wrong = goodSite();
  wrong.set('/manifest.json', { type: 'application/json', text: '{"pages":[]}' });
  await expect(loadManifest(BASE, serve(wrong).fetchImpl)).rejects.toThrow();
});

test('every page, twin and index document is fetched once; a page redirect is followed', async () => {
  const { fetchImpl, requests } = serve(goodSite());
  const surfaces = await fetchSurfaces(BASE, manifest, fetchImpl);
  expect([...surfaces.pages.keys()]).toEqual(manifest.pages);
  expect([...surfaces.twins.keys()]).toEqual(manifest.pages.map(twinOf));
  // The Link header is the first answer's, the document is the one the redirect leads to.
  expect(surfaces.pages.get('/404/')).toMatchObject({
    status: 200,
    type: 'text/html; charset=utf-8',
    link: '</404.md>; rel="alternate"; type="text/markdown"',
    text: '<h1>Not found</h1>',
  });
  expect(surfaces.llmsTxt.text).toBe('# The 40 Thieves\n');
  expect(surfaces.agents.type).toBe('text/markdown; charset=utf-8');
  expect(requests.filter((request) => request.path === '/404/')[0]?.redirect).toBe('manual');
  expect(requests).toHaveLength(manifest.pages.length * 2 + 3 + 1);
});

test('twins: every page links its twin and every twin is Markdown', async () => {
  const rows = twinRows(manifest, await fetchSurfaces(BASE, manifest, serve(goodSite()).fetchImpl));
  expect(failed(rows)).toEqual([]);
  expect(rows.map((row) => row.check)).toEqual([
    ...manifest.pages.flatMap((page) => [page, twinOf(page)]),
    '/llms.txt',
    '/llms-full.txt',
    '/AGENTS.md',
  ]);
  expect(rows.every((row) => row.group === 'twins')).toBe(true);
});

test('twins: each broken document fails its own row and no other', async () => {
  const broken = async (change: (site: Map<string, Doc>) => void) => {
    const site = goodSite();
    change(site);
    return failed(twinRows(manifest, await fetchSurfaces(BASE, manifest, serve(site).fetchImpl)));
  };
  // The hub's 404 page in place of a twin: a 200 would not have helped, the type is the check.
  expect(await broken((site) => site.delete('/codecalc.md'))).toEqual(['/codecalc.md']);
  expect(
    await broken((site) => site.set('/codecalc.md', { type: 'text/html', text: '<h1>x</h1>' })),
  ).toEqual(['/codecalc.md']);
  expect(
    await broken((site) =>
      site.set('/codecalc/', { type: 'text/html; charset=utf-8', text: '<h1>x</h1>', link: null }),
    ),
  ).toEqual(['/codecalc/']);
  expect(
    await broken((site) =>
      site.set('/codecalc/', {
        type: 'text/html; charset=utf-8',
        text: '<h1>x</h1>',
        link: '</index.md>; rel="alternate"; type="text/markdown"',
      }),
    ),
  ).toEqual(['/codecalc/']);
  expect(await broken((site) => site.delete('/changelog/'))).toEqual(['/changelog/']);
  expect(
    await broken((site) =>
      site.set('/llms-full.txt', {
        type: 'text/plain; charset=utf-8',
        text: 'x'.repeat(1_000_000),
      }),
    ),
  ).toEqual(['/llms-full.txt']);
  expect(
    await broken((site) => site.set('/AGENTS.md', { type: 'text/plain', text: '# AGENTS.md\n' })),
  ).toEqual(['/AGENTS.md']);
  expect(await broken((site) => site.delete('/llms.txt'))).toEqual(['/llms.txt']);
});

const doc = (text: string, type = 'text/html; charset=utf-8'): Fetched => ({
  status: 200,
  type,
  text,
  link: null,
  bytes: text.length,
});
const served = { mcpTools: [...MCP_TOOL_NAMES], webmcpServed: [...WEBMCP_TOOL_NAMES] };

function surfacesOf(pages: [string, string][], llms: string): Surfaces {
  return {
    pages: new Map(pages.map(([path, html]) => [path, doc(html)])),
    twins: new Map(),
    llmsTxt: doc(llms, 'text/plain; charset=utf-8'),
    llmsFull: doc('', 'text/plain; charset=utf-8'),
    agents: doc('', 'text/markdown; charset=utf-8'),
  };
}

test('drift: surfaces inside the manifest are one passing row', () => {
  const rows = driftRows({ ...manifest, pages: [] }, surfacesOf([], '# The 40 Thieves\n'), served);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ group: 'drift', check: 'manifest contract', status: 'pass' });
});

test('drift: anything a surface says that the manifest does not is a failed row naming it', () => {
  const rows = driftRows(
    manifest,
    surfacesOf([['/', '<a href="/ghost/">ghost</a>']], '- [phantom](https://example.com): x\n'),
    { mcpTools: [...MCP_TOOL_NAMES, 'delete_everything'], webmcpServed: null },
  );
  expect(rows.every((row) => row.group === 'drift' && row.status === 'fail')).toBe(true);
  expect(rows).toContainEqual({
    group: 'drift',
    check: 'pages',
    status: 'fail',
    detail: '/: links to /ghost/, which is not in manifest.pages',
  });
  expect(rows).toContainEqual({
    group: 'drift',
    check: 'llms.txt',
    status: 'fail',
    detail: '/llms.txt: names phantom, which is not a manifest project',
  });
  expect(rows.some((row) => row.check === 'mcp' && row.detail.includes('delete_everything'))).toBe(
    true,
  );
});

test('a logged failure whose detail spans lines is still a row', () => {
  expect(rowsFromLog('protocol', ['FAIL get_project: fetch failed\n  cause: ECONNRESET'])).toEqual([
    {
      group: 'protocol',
      check: 'get_project',
      status: 'fail',
      detail: 'fetch failed\n  cause: ECONNRESET',
    },
  ]);
});

test('logged: what a smoke function logs becomes the rows of its group', async () => {
  const rows = await logged('discovery', (log) => {
    log('ok ai-catalog: https://the40thieves.dev/mcp/server-card');
    log('FAIL server-card: status 500');
    return Promise.resolve([{ step: 'server-card', detail: 'status 500' }]);
  });
  expect(statuses(rows)).toEqual(['ai-catalog: pass', 'server-card: fail']);
  expect(rows.every((row) => row.group === 'discovery')).toBe(true);
});

test('logged: a throw keeps the rows before it and adds a failed one', async () => {
  const rows = await logged('protocol', (log) => {
    log('ok discover: 2026-07-28');
    return Promise.reject(new Error('socket hang up'));
  });
  expect(rows).toEqual([
    { group: 'protocol', check: 'discover', status: 'pass', detail: '2026-07-28' },
    { group: 'protocol', check: 'ran', status: 'fail', detail: 'socket hang up' },
  ]);
});

test('logged: a failure that was returned but never logged as a row still fails the group', async () => {
  const rows = await logged('page tools', (log) => {
    log('page tools are in a new log format');
    return Promise.resolve([{ step: 'page tools call', detail: 'status 500' }]);
  });
  expect(rows).toEqual([
    {
      group: 'page tools',
      check: 'unreported failure',
      status: 'fail',
      detail: 'page tools call: status 500',
    },
  ]);
});

test('logged: a group that reports nothing has not been checked', async () => {
  const rows = await logged('page tools', () => Promise.resolve([]));
  expect(rows).toEqual([
    {
      group: 'page tools',
      check: 'ran',
      status: 'fail',
      detail: 'no check reported a result',
    },
  ]);
});

test('the page tool list is the names /mcp/webmcp answers, or null while the switch is off', async () => {
  const on = scripted(() => ({
    status: 200,
    body: { enabled: true, tools: [{ name: 'search_projects' }, { name: 'read_doc' }] },
  }));
  expect(await servedPageTools(new URL('http://127.0.0.1:8790'), on.fetchImpl)).toEqual([
    'search_projects',
    'read_doc',
  ]);
  expect(on.calls.map((call) => call.url.href)).toEqual(['http://127.0.0.1:8790/mcp/webmcp']);

  const off = scripted(() => ({ status: 200, body: { enabled: false, tools: [] } }));
  expect(await servedPageTools(new URL('http://127.0.0.1:8790'), off.fetchImpl)).toBeNull();

  // Anything else is not an answer to compare with: the drift group fails on it.
  const down = scripted(() => ({ status: 502, body: { error: 'unreachable' } }));
  await expect(servedPageTools(new URL('http://127.0.0.1:8790'), down.fetchImpl)).rejects.toThrow(
    /\/mcp\/webmcp answered 502/,
  );
  const odd = scripted(() => ({ status: 200, body: { tools: 'none' } }));
  await expect(servedPageTools(new URL('http://127.0.0.1:8790'), odd.fetchImpl)).rejects.toThrow(
    /not \{ enabled, tools \}/,
  );
});
