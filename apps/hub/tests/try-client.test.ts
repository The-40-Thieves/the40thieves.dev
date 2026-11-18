import { expect, test } from 'vitest';

import {
  answerPrompt,
  answerRequest,
  citeParts,
  pickForAnswer,
  providerOf,
  readAnswer,
} from '../src/lib/try/answer.ts';
import { memoryFiles, ResultCache, CACHE_TTL_MS } from '../src/lib/try/cache.ts';
import { KeyStore, SESSION_KEY, type KeyStorage } from '../src/lib/try/keys.ts';
import {
  failureText,
  mintSession,
  RELAY_ORIGIN,
  routeRequest,
  sessionIsFresh,
  sitekeyFor,
  TURNSTILE_SITEKEY,
} from '../src/lib/try/relay.ts';
import { TRY_SOURCES, type TryResult, type TrySource } from '../src/lib/try/sources.ts';
import { webUrl } from '../src/lib/try/text.ts';
import { tierFor, TIERS } from '../src/lib/try/tier.ts';

// The try app's client logic (P4-S4), outside the browser: routing, the relay session, the
// key store's reload behaviour, tiers, the OPFS cache over a Map, and the cited answer.

function source(name: string): TrySource {
  const found = TRY_SOURCES.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(name);
  return found;
}

function result(src: string, n: number): TryResult {
  return {
    source: src,
    id: `${src}-${String(n)}`,
    title: `${src} ${String(n)}`,
    url: null,
    authors: [],
    year: null,
    snippet: '',
  };
}

function fakeStorage(): KeyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

test('browser-direct requests go straight out, without credentials', () => {
  const routed = routeRequest(
    source('openalex'),
    { url: 'https://api.openalex.org/works', headers: {} },
    null,
  );
  expect(routed.url).toBe('https://api.openalex.org/works');
  expect(routed.init.credentials).toBe('omit');
});

test('visitor-key sources go to /v1/fetch with target, session and the visitor key', () => {
  const core = source('core');
  const routed = routeRequest(core, core.request('q', 5, 'k'), 'sess');
  expect(routed.url).toBe(`${RELAY_ORIGIN}/v1/fetch`);
  expect(routed.init.headers).toMatchObject({
    authorization: 'Bearer k',
    'x-relay-session': 'sess',
    'x-relay-target': core.request('q', 5).url,
  });
});

test('quota sources go to /v1/quota/<name>, and the relay routes refuse to run without a session', () => {
  const guardian = source('guardian');
  expect(routeRequest(guardian, guardian.request('q', 5), 's').url).toBe(
    `${RELAY_ORIGIN}/v1/quota/guardian`,
  );
  expect(() => routeRequest(guardian, guardian.request('q', 5), null)).toThrow(/session/);
});

test('sessions: minted from a Turnstile token, fresh until a minute before expiry', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(Response.json({ session: 'v1.s', expires_at: 2_000 }));
  }) as typeof fetch;
  const minted = await mintSession('tok', fetcher);
  expect(minted).toEqual({ session: 'v1.s', expiresAt: 2_000_000 });
  expect(calls[0]?.url).toBe(`${RELAY_ORIGIN}/v1/session`);
  expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ token: 'tok' });
  expect(sessionIsFresh(minted, 1_900_000)).toBe(true);
  expect(sessionIsFresh(minted, 1_950_000)).toBe(false);
  expect(sessionIsFresh(null, 0)).toBe(false);
  const refused = (() =>
    Promise.resolve(Response.json({ error: 'x' }, { status: 403 }))) as typeof fetch;
  await expect(mintSession('tok', refused)).rejects.toThrow(/403/);
});

test('the production sitekey is used on the production host only', () => {
  expect(sitekeyFor('the40thieves.dev')).toBe(TURNSTILE_SITEKEY);
  expect(sitekeyFor('127.0.0.1')).not.toBe(TURNSTILE_SITEKEY);
});

test('failures read as something a visitor can act on', () => {
  expect(failureText(429, '7200', 'quota_reached')).toMatch(/about 2 h/);
  expect(failureText(429, null, 'rate_limited')).toMatch(/this minute/);
  // The kill switch (P4-S5) is not "not configured".
  expect(failureText(503, '300', 'paused')).toMatch(/paused/);
  expect(failureText(503, null, 'not_configured')).toMatch(/Not configured/);
  // An upstream 429 passed through the relay is the source's limit, not the daily allowance.
  expect(failureText(429, '60', null)).toMatch(/limiting requests.*about a minute/);
  expect(failureText(429, '60', null)).not.toMatch(/Daily allowance/);
  // A longer Retry-After is honoured, and none at all gets no promised interval.
  expect(failureText(429, '300', null)).toMatch(/about 5 minutes/);
  expect(failureText(429, null, null)).toMatch(/try again shortly/);
  expect(failureText(503, null, 'not_configured')).toMatch(/Not configured/);
  expect(failureText(401, null)).toMatch(/key/);
  expect(failureText(500, null)).toBe('The source answered 500.');
});

test('keys: memory only by default, so a reload (a new store) forgets them', () => {
  const storage = fakeStorage();
  const store = new KeyStore(storage);
  store.set('llm', ' sk-ant-secret ');
  expect(store.get('llm')).toBe('sk-ant-secret');
  expect(storage.data.size).toBe(0);
  expect(new KeyStore(storage).get('llm')).toBe('');
});

test('keys: the tab opt-in survives a reload, and turning it off or forgetting removes it', () => {
  const storage = fakeStorage();
  const store = new KeyStore(storage);
  store.set('llm', 'sk-1');
  store.setPersist(true);
  expect(JSON.parse(storage.data.get(SESSION_KEY) ?? '{}')).toEqual({ llm: 'sk-1' });
  const reloaded = new KeyStore(storage);
  expect(reloaded.persisted).toBe(true);
  expect(reloaded.get('llm')).toBe('sk-1');
  reloaded.setPersist(false);
  expect(storage.data.has(SESSION_KEY)).toBe(false);
  reloaded.setPersist(true);
  reloaded.clear();
  expect(storage.data.has(SESSION_KEY)).toBe(false);
  expect(reloaded.get('llm')).toBe('');
});

test('keys: blocked or corrupt storage leaves the keys in memory', () => {
  const throwing: KeyStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const store = new KeyStore(throwing);
  store.setPersist(true);
  store.set('llm', 'k');
  expect(store.get('llm')).toBe('k');
  const corrupt = fakeStorage();
  corrupt.data.set(SESSION_KEY, '[1,2]');
  expect(new KeyStore(corrupt).persisted).toBe(false);
});

test('tiers come from reported device memory', () => {
  expect(tierFor(undefined)).toBe(TIERS.standard);
  expect(tierFor(0.5)).toBe(TIERS.lite);
  expect(tierFor(1)).toBe(TIERS.lite);
  expect(tierFor(4)).toBe(TIERS.standard);
  expect(tierFor(8)).toBe(TIERS.full);
  expect(TIERS.lite.cacheEntries).toBe(0);
});

test('cache: a repeat search hits, order of sources does not matter, nothing secret is stored', async () => {
  const files = memoryFiles();
  let now = 1_000;
  const cache = new ResultCache(files, 2, () => now);
  const rows = [result('openalex', 1)];
  await cache.put('Graph Nets', ['openalex', 'crossref'], 10, rows);
  expect((await cache.get(' graph nets ', ['crossref', 'openalex'], 10))?.results).toEqual(rows);
  expect(await cache.get('graph nets', ['openalex'], 10)).toBeNull();
  expect(await cache.get('graph nets', ['openalex', 'crossref'], 5)).toBeNull();
  for (const body of files.files.values()) expect(body).not.toMatch(/sk-|session|authorization/i);
  now += CACHE_TTL_MS + 1;
  expect(await cache.get('graph nets', ['openalex', 'crossref'], 10)).toBeNull();
});

test('cache: the oldest entries go once the tier limit is reached; limit 0 is off', async () => {
  const files = memoryFiles();
  let now = 0;
  const cache = new ResultCache(files, 2, () => now);
  for (const q of ['a', 'b', 'c']) {
    now += 10;
    await cache.put(q, ['openalex'], 5, [result('openalex', 1)]);
  }
  expect(await cache.get('a', ['openalex'], 5)).toBeNull();
  expect(await cache.get('c', ['openalex'], 5)).not.toBeNull();
  expect([...files.files.keys()].filter((name) => name !== 'index.json')).toHaveLength(2);
  await cache.clear();
  expect(files.files.size).toBe(0);
  const off = new ResultCache(memoryFiles(), 0);
  await off.put('a', ['openalex'], 5, [result('openalex', 1)]);
  expect(await off.get('a', ['openalex'], 5)).toBeNull();
});

test('answer: picks one source at a time, up to eight', () => {
  const rows = [
    ...[1, 2, 3, 4, 5, 6].map((n) => result('openalex', n)),
    result('arxiv', 1),
    result('guardian', 1),
  ];
  expect(pickForAnswer(rows).map((r) => r.id)).toEqual([
    'openalex-1',
    'arxiv-1',
    'guardian-1',
    'openalex-2',
    'openalex-3',
    'openalex-4',
    'openalex-5',
    'openalex-6',
  ]);
  expect(pickForAnswer(rows, 3)).toHaveLength(3);
  expect(pickForAnswer([])).toEqual([]);
});

test('answer: the prompt numbers the sources and fences them as data', () => {
  const prompt = answerPrompt('why?', [result('arxiv', 1), result('core', 2)]);
  expect(prompt).toContain('Question: why?');
  expect(prompt).toContain('<source n="1">\nTitle: arxiv 1');
  expect(prompt).toContain('<source n="2">');
});

test('answer: provider requests carry the key only to that provider', () => {
  const anthropic = answerRequest('anthropic', 'sk-ant-k', 'm', 'q', [result('arxiv', 1)]);
  expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages');
  expect(anthropic.init.headers).toMatchObject({
    'x-api-key': 'sk-ant-k',
    'anthropic-dangerous-direct-browser-access': 'true',
  });
  expect(JSON.parse(anthropic.init.body as string)).toMatchObject({ model: 'm' });
  const openai = answerRequest('openai', 'sk-k', 'm', 'q', []);
  expect(openai.url).toBe('https://api.openai.com/v1/chat/completions');
  expect(openai.init.headers).toMatchObject({ authorization: 'Bearer sk-k' });
  expect(providerOf('sk-ant-x')).toBe('anthropic');
  expect(providerOf('sk-proj-x')).toBe('openai');
  expect(providerOf('xyz')).toBeNull();
});

test('answer: reading responses and splitting citations', () => {
  expect(
    readAnswer('anthropic', {
      content: [{ type: 'text', text: 'A [1]' }, { type: 'tool_use' }],
    }),
  ).toBe('A [1]');
  expect(readAnswer('openai', { choices: [{ message: { content: ' B [2] ' } }] })).toBe('B [2]');
  expect(() => readAnswer('openai', { error: { message: 'bad key' } })).toThrow('bad key');
  expect(citeParts('X [1] and [2][9] end', 2)).toEqual([
    { text: 'X ' },
    { cite: 1 },
    { text: ' and ' },
    { cite: 2 },
    { text: '[9] end' },
  ]);
});

test('a result link is an absolute http or https URL, or nothing', () => {
  expect(webUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
  expect(webUrl('http://example.org/')).toBe('http://example.org/');
  for (const value of [
    null,
    '',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '/relative',
    'example.org',
  ]) {
    expect(webUrl(value), String(value)).toBeNull();
  }
});
