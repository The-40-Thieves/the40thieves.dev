import { expect, test, vi } from 'vitest';

import {
  LOCK_TTL_S,
  NONCE_TTL_S,
  claimNonce,
  createGitHubDispatcher,
  flushPending,
  requestRebuild,
  type Trigger,
} from '../src/dispatch.ts';
import { FakeClock, FakeStore } from './fake-store.ts';

const trigger: Trigger = {
  source: 'github',
  event: 'push',
  subject: 'The-40-Thieves/codecalc refs/heads/main',
};
const later: Trigger = { source: 'sanity', event: 'document.update', subject: 'abc' };

test('a delivery id is accepted once and rejected on replay for a day', async () => {
  const clock = new FakeClock(1_762_300_000_000);
  const store = new FakeStore(clock);
  expect(await claimNonce(store, 'github', 'delivery-1')).toBe(true);
  expect(await claimNonce(store, 'github', 'delivery-1')).toBe(false);
  expect(await claimNonce(store, 'sanity', 'delivery-1')).toBe(true);
  clock.advance(NONCE_TTL_S * 1000 + 1);
  expect(await claimNonce(store, 'github', 'delivery-1')).toBe(true);
  expect(NONCE_TTL_S).toBe(24 * 60 * 60);
});

test('ten events in a minute produce one dispatch now and one flush with the last trigger', async () => {
  const clock = new FakeClock(1_762_300_000_000);
  const store = new FakeStore(clock);
  const sent: Trigger[] = [];
  const send = (t: Trigger) => {
    sent.push(t);
    return Promise.resolve();
  };
  expect(await requestRebuild(store, trigger, send)).toBe('dispatched');
  for (let i = 0; i < 9; i += 1) {
    clock.advance(5000);
    expect(await requestRebuild(store, i === 8 ? later : trigger, send)).toBe('coalesced');
  }
  expect(sent).toHaveLength(1);
  // The cron tick inside the lock window does nothing.
  expect(await flushPending(store, send)).toBe('idle');
  clock.advance(LOCK_TTL_S * 1000);
  expect(await flushPending(store, send)).toBe('dispatched');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(later);
  // Flushed once; the next tick is idle again.
  expect(await flushPending(store, send)).toBe('idle');
  expect(LOCK_TTL_S).toBe(60);
});

test('a lone event dispatches and leaves nothing pending', async () => {
  const clock = new FakeClock(1_762_300_000_000);
  const store = new FakeStore(clock);
  const send = vi.fn(() => Promise.resolve());
  expect(await requestRebuild(store, trigger, send)).toBe('dispatched');
  clock.advance(LOCK_TTL_S * 1000);
  expect(await flushPending(store, send)).toBe('idle');
  expect(send).toHaveBeenCalledTimes(1);
});

test('the GitHub dispatcher posts a rebuild repository_dispatch as the App installation', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  const send = createGitHubDispatcher({
    owner: 'The-40-Thieves',
    repo: 'the40thieves.dev',
    token: () => Promise.resolve('ghs_installation'),
    fetchImpl,
    now: () => 1_762_300_000_000,
  });
  await send(trigger);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(
    'https://api.github.com/repos/The-40-Thieves/the40thieves.dev/dispatches',
  );
  const init = calls[0]?.init;
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghs_installation');
  expect(JSON.parse(init?.body as string)).toEqual({
    event_type: 'rebuild',
    client_payload: { ...trigger, at: '2025-11-04T23:46:40.000Z' },
  });
});

test('the dispatcher throws on anything but 204 without echoing the token', async () => {
  const send = createGitHubDispatcher({
    owner: 'o',
    repo: 'r',
    token: () => Promise.resolve('ghs_secret'),
    fetchImpl: () => Promise.resolve(new Response('nope', { status: 403 })),
    now: () => 0,
  });
  await expect(send(trigger)).rejects.toThrow(/403/);
  await expect(send(trigger)).rejects.not.toThrow(/ghs_secret/);
});
test('a flush whose dispatch fails keeps the parked trigger for the next tick', async () => {
  const clock = new FakeClock(1_762_300_000_000);
  const store = new FakeStore(clock);
  let fail = false;
  const sent: Trigger[] = [];
  const send = (t: Trigger) => {
    if (fail) return Promise.reject(new Error('HTTP 502'));
    sent.push(t);
    return Promise.resolve();
  };
  expect(await requestRebuild(store, trigger, send)).toBe('dispatched');
  expect(await requestRebuild(store, later, send)).toBe('coalesced');
  clock.advance(LOCK_TTL_S * 1000);
  fail = true;
  await expect(flushPending(store, send)).rejects.toThrow('HTTP 502');
  fail = false;
  expect(await flushPending(store, send)).toBe('dispatched');
  expect(sent).toEqual([trigger, later]);
});
