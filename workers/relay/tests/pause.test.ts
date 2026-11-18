import { expect, test } from 'vitest';

import {
  createPauseCheck,
  isPausedValue,
  PAUSE_CACHE_TTL_SECONDS,
  PAUSE_KEY,
  PAUSE_RETRY_AFTER_SECONDS,
} from '../../../security/pause-flag.ts';
import { ERROR_CODES } from '../src/handler.ts';

import {
  BASE,
  expectPolicyHeaders,
  fetchRequest,
  harness,
  session,
  sessionRequest,
  SITE,
} from './fakes.ts';

const paused = (): Promise<boolean> => Promise.resolve(true);

async function expectPaused(response: Response): Promise<void> {
  expect(response.status).toBe(ERROR_CODES.paused);
  expect(await response.json()).toEqual({ error: 'paused' });
  expect(response.headers.get('retry-after')).toBe(String(PAUSE_RETRY_AFTER_SECONDS));
  expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  expectPolicyHeaders(response);
}

test('a missing key and the off words are not paused; anything else is', () => {
  for (const value of [null, '', '0', 'false', 'OFF', ' no ']) {
    expect(isPausedValue(value), String(value)).toBe(false);
  }
  for (const value of ['1', 'true', 'on', 'abuse 2026-11-18', '{"reason":"x"}']) {
    expect(isPausedValue(value), value).toBe(true);
  }
});

test('the check reads the one key with the shortest cache KV allows', async () => {
  const reads: [string, { cacheTtl: number }][] = [];
  const check = createPauseCheck({
    get: (key, options) => {
      reads.push([key, options]);
      return Promise.resolve('1');
    },
  });
  expect(await check()).toBe(true);
  expect(reads).toEqual([[PAUSE_KEY, { cacheTtl: PAUSE_CACHE_TTL_SECONDS }]]);
  expect(PAUSE_CACHE_TTL_SECONDS).toBe(30);
});

test('without a store the check is never paused', async () => {
  expect(await createPauseCheck(undefined)()).toBe(false);
});

test('a failed read keeps the last value seen and reports the error', async () => {
  let value: string | null | Error = new Error('kv down');
  const errors: unknown[] = [];
  const check = createPauseCheck(
    {
      get: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
    },
    (error) => errors.push(error),
  );
  // Before any read succeeds, an outage does not pause the site.
  expect(await check()).toBe(false);
  value = '1';
  expect(await check()).toBe(true);
  // Once paused, an outage does not resume it.
  value = new Error('kv down again');
  expect(await check()).toBe(true);
  value = null;
  expect(await check()).toBe(false);
  expect(errors).toHaveLength(2);
});

test('paused: fetch, quota and session answer 503 paused and nothing goes upstream', async () => {
  let turnstileCalls = 0;
  const h = harness({
    paused,
    verifyTurnstile: () => {
      turnstileCalls += 1;
      return Promise.resolve(true);
    },
  });
  await expectPaused(await h.send(fetchRequest({ session: await session() })));
  await expectPaused(await h.send(sessionRequest(JSON.stringify({ token: 'good-token' }))));
  expect(h.calls).toEqual([]);
  expect(turnstileCalls).toBe(0);
  // Neither budget is spent while paused.
  expect(h.limiter.counts.size).toBe(0);
  expect(h.sessionLimiter.counts.size).toBe(0);
  expect(h.logs.map((entry) => [entry.route, entry.outcome, entry.status])).toEqual([
    ['fetch', 'paused', 503],
    ['session', 'paused', 503],
  ]);
});

test('paused: the checks that need no await still answer first', async () => {
  const h = harness({ paused });
  const offList = await h.send(fetchRequest({ target: 'https://example.invalid/x' }));
  expect(await offList.json()).toEqual({ error: 'host_not_allowed' });
  const noOrigin = await h.send(fetchRequest({ origin: null }));
  expect(await noOrigin.json()).toEqual({ error: 'origin_not_allowed' });
  expect(h.calls).toEqual([]);
});

test('paused: preflights still answer, and healthz says so', async () => {
  const h = harness({ paused });
  const preflight = await h.send(
    new Request(`${BASE}/v1/fetch`, {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-method': 'GET' },
    }),
  );
  expect(preflight.status).toBe(204);
  const health = await h.send(new Request(`${BASE}/v1/healthz`));
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, configured: true, paused: true });
});

test('not paused: healthz reports paused false and a fetch is relayed', async () => {
  const h = harness({ paused: () => Promise.resolve(false) });
  const health = await h.send(new Request(`${BASE}/v1/healthz`));
  expect(await health.json()).toMatchObject({ paused: false });
  const relayed = await h.send(fetchRequest({ session: await session() }));
  expect(relayed.status).toBe(200);
  expect(h.calls).toHaveLength(1);
});
