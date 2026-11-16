import { expect, test, vi } from 'vitest';

import type { Trigger } from '../src/dispatch.ts';
import { handleRequest, type HandlerDeps, type HandlerEnv } from '../src/handler.ts';
import { signGitHub, signSanity } from '../src/signatures.ts';
import { FakeClock, FakeStore } from './fake-store.ts';

const env: HandlerEnv = {
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  SANITY_WEBHOOK_SECRET: 'sanity-secret',
  SANITY_DATASET: 'the40thieves',
};

function harness(at = 1_762_300_000_000) {
  const clock = new FakeClock(at);
  const store = new FakeStore(clock);
  const sent: Trigger[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: HandlerDeps = {
    store,
    send: (t) => {
      sent.push(t);
      return Promise.resolve();
    },
    now: clock.now,
    log: (entry) => {
      logs.push(entry);
    },
  };
  return { clock, store, sent, logs, deps };
}

const releaseBody = JSON.stringify({
  action: 'published',
  release: { tag_name: 'v0.13.0' },
  repository: { full_name: 'The-40-Thieves/codecalc', default_branch: 'main' },
});

async function githubRequest(
  body: string,
  secret = 'gh-secret',
  delivery = 'd-1',
  event = 'release',
) {
  return new Request('https://hooks.the40thieves.dev/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': await signGitHub(secret, body),
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body,
  });
}

test('a signed release delivery dispatches once and a replay is a 409', async () => {
  const h = harness();
  const first = await handleRequest(await githubRequest(releaseBody), env, h.deps);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ status: 'dispatched' });
  expect(h.sent).toEqual([
    { source: 'github', event: 'release.published', subject: 'The-40-Thieves/codecalc v0.13.0' },
  ]);
  const replay = await handleRequest(await githubRequest(releaseBody), env, h.deps);
  expect(replay.status).toBe(409);
  expect(h.sent).toHaveLength(1);
});

test('a bad signature is a 401, logged without the body, and never touches the store', async () => {
  const h = harness();
  const response = await handleRequest(await githubRequest(releaseBody, 'wrong'), env, h.deps);
  expect(response.status).toBe(401);
  expect(h.sent).toHaveLength(0);
  expect(h.store.puts).toHaveLength(0);
  expect(h.logs).toHaveLength(1);
  expect(JSON.stringify(h.logs[0])).not.toContain('v0.13.0');
  expect(h.logs[0]).toMatchObject({ route: 'github', reason: 'bad-signature' });
});

test('an ignored event is a 204 and a second rebuild in the lock window is coalesced', async () => {
  const h = harness();
  const ping = await handleRequest(
    await githubRequest('{"zen":"x"}', 'gh-secret', 'd-ping', 'ping'),
    env,
    h.deps,
  );
  expect(ping.status).toBe(204);
  expect(h.sent).toHaveLength(0);
  expect(
    (await handleRequest(await githubRequest(releaseBody, 'gh-secret', 'd-2'), env, h.deps)).status,
  ).toBe(202);
  const second = await handleRequest(
    await githubRequest(releaseBody, 'gh-secret', 'd-3'),
    env,
    h.deps,
  );
  expect(await second.json()).toEqual({ status: 'coalesced' });
  expect(h.sent).toHaveLength(1);
});

test('missing event headers are a 400 and a missing secret is a 500 before any verification', async () => {
  const h = harness();
  const noHeaders = new Request('https://hooks.the40thieves.dev/github', {
    method: 'POST',
    body: releaseBody,
  });
  expect((await handleRequest(noHeaders, env, h.deps)).status).toBe(400);
  const unconfigured = await handleRequest(
    await githubRequest(releaseBody),
    { ...env, GITHUB_WEBHOOK_SECRET: undefined },
    h.deps,
  );
  expect(unconfigured.status).toBe(500);
  expect(h.sent).toHaveLength(0);
});

test('a signed Sanity publish dispatches, a stale one is a 401, and its idempotency key blocks replay', async () => {
  const h = harness();
  const body = '{"_id":"abc","_type":"spotlight"}';
  const request = async (ts: number, key = 'idem-1') =>
    new Request('https://hooks.the40thieves.dev/sanity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sanity-webhook-signature': await signSanity('sanity-secret', body, ts),
        'idempotency-key': key,
        'sanity-operation': 'update',
        'sanity-document-id': 'abc',
        'sanity-dataset': 'the40thieves',
      },
      body,
    });
  const ok = await handleRequest(await request(h.clock.now() - 1000), env, h.deps);
  expect(ok.status).toBe(202);
  expect(h.sent).toEqual([{ source: 'sanity', event: 'document.update', subject: 'abc' }]);
  expect((await handleRequest(await request(h.clock.now() - 1000), env, h.deps)).status).toBe(409);
  const stale = await handleRequest(
    await request(h.clock.now() - 6 * 60 * 1000, 'idem-2'),
    env,
    h.deps,
  );
  expect(stale.status).toBe(401);
  expect(h.logs.at(-1)).toMatchObject({ route: 'sanity', reason: 'stale' });
  expect(h.sent).toHaveLength(1);
});

test('health answers, unknown paths are 404, wrong methods are 405, oversized bodies are 413', async () => {
  const h = harness();
  const health = await handleRequest(
    new Request('https://hooks.the40thieves.dev/healthz'),
    env,
    h.deps,
  );
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  expect(
    (await handleRequest(new Request('https://hooks.the40thieves.dev/'), env, h.deps)).status,
  ).toBe(404);
  expect(
    (await handleRequest(new Request('https://hooks.the40thieves.dev/github'), env, h.deps)).status,
  ).toBe(405);
  const big = new Request('https://hooks.the40thieves.dev/github', {
    method: 'POST',
    headers: {
      'content-length': String(2 * 1024 * 1024),
      'x-github-event': 'push',
      'x-github-delivery': 'd',
    },
    body: 'x',
  });
  expect((await handleRequest(big, env, h.deps)).status).toBe(413);
  expect(h.sent).toHaveLength(0);
  const send = vi.fn();
  expect(send).not.toHaveBeenCalled();
});
test('a failed dispatch is a 502 and frees the delivery id so a redelivery can try again', async () => {
  const h = harness();
  let fail = true;
  h.deps.send = () => (fail ? Promise.reject(new Error('HTTP 403')) : Promise.resolve());
  expect((await handleRequest(await githubRequest(releaseBody), env, h.deps)).status).toBe(502);
  expect(h.logs.at(-1)).toMatchObject({
    route: 'github',
    reason: 'dispatch-failed',
  });
  fail = false;
  expect((await handleRequest(await githubRequest(releaseBody), env, h.deps)).status).toBe(202);
});
test('a push to the hub repository itself is a 204 when the dispatch target is configured', async () => {
  const h = harness();
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    repository: {
      full_name: 'The-40-Thieves/the40thieves.dev',
      default_branch: 'main',
    },
  });
  const self = {
    ...env,
    DISPATCH_OWNER: 'The-40-Thieves',
    DISPATCH_REPO: 'the40thieves.dev',
  };
  const response = await handleRequest(
    await githubRequest(body, 'gh-secret', 'd-self', 'push'),
    self,
    h.deps,
  );
  expect(response.status).toBe(204);
  expect(h.sent).toHaveLength(0);
});
