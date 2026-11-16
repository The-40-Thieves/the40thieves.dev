import { GITHUB_API } from '@the40thieves/github';

import type { Trigger } from './events.ts';
import type { Store } from './store.ts';

export type { Trigger } from './events.ts';

/** A delivery id is remembered for a day; GitHub and Sanity both redeliver well inside that. */
export const NONCE_TTL_S = 24 * 60 * 60;
/** After a dispatch, further triggers coalesce for this long (KV's minimum TTL is 60 s). */
export const LOCK_TTL_S = 60;
/** A pending trigger the cron never flushed (KV lag, outage) expires rather than firing late. */
const PENDING_TTL_S = 10 * 60;

const LOCK_KEY = 'rebuild:lock';
const PENDING_KEY = 'rebuild:pending';

export type Send = (trigger: Trigger) => Promise<void>;

/** The slice of fetch the dispatcher needs; `fetch` itself satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Claims a delivery id for its route. True the first time, false on a replay within the TTL.
 * KV is eventually consistent, so two copies of one delivery racing through different colos
 * within the same second can both win; the debounce below then turns them into one build.
 */
export async function claimNonce(store: Store, route: string, id: string): Promise<boolean> {
  const key = `nonce:${route}:${id}`;
  if ((await store.get(key)) !== null) return false;
  await store.put(key, '1', { expirationTtl: NONCE_TTL_S });
  return true;
}

export async function releaseNonce(store: Store, route: string, id: string): Promise<void> {
  await store.delete(`nonce:${route}:${id}`);
}

export type RebuildOutcome = 'dispatched' | 'coalesced';

/**
 * Debounce: the first trigger dispatches at once and takes a lock; anything that arrives while
 * the lock stands is parked as the pending trigger (last writer wins) for the cron to flush.
 * Ten pushes in a minute therefore cost one build now and one trailing build.
 */
export async function requestRebuild(
  store: Store,
  trigger: Trigger,
  send: Send,
): Promise<RebuildOutcome> {
  if ((await store.get(LOCK_KEY)) !== null) {
    await store.put(PENDING_KEY, JSON.stringify(trigger), { expirationTtl: PENDING_TTL_S });
    return 'coalesced';
  }
  await dispatchWithLock(store, trigger, send);
  return 'dispatched';
}

export type FlushOutcome = 'dispatched' | 'idle';

/** The cron tick: once the lock has expired, dispatch the parked trigger, if any. */
export async function flushPending(store: Store, send: Send): Promise<FlushOutcome> {
  if ((await store.get(LOCK_KEY)) !== null) return 'idle';
  const parked = await store.get(PENDING_KEY);
  if (parked === null) return 'idle';
  await store.delete(PENDING_KEY);
  const trigger = parseTrigger(parked);
  if (trigger === null) return 'idle';
  try {
    await dispatchWithLock(store, trigger, send);
  } catch (error) {
    // Keep the trigger for the next tick, unless a newer one was parked while we tried.
    if ((await store.get(PENDING_KEY)) === null) {
      await store.put(PENDING_KEY, parked, { expirationTtl: PENDING_TTL_S });
    }
    throw error;
  }
  return 'dispatched';
}

async function dispatchWithLock(store: Store, trigger: Trigger, send: Send): Promise<void> {
  await store.put(LOCK_KEY, trigger.subject, { expirationTtl: LOCK_TTL_S });
  try {
    await send(trigger);
  } catch (error) {
    // A failed dispatch must not hold the next trigger back for a minute.
    await store.delete(LOCK_KEY);
    throw error;
  }
}

function parseTrigger(text: string): Trigger | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { source, event, subject } = value as Record<string, unknown>;
    if ((source !== 'github' && source !== 'sanity') || typeof event !== 'string') return null;
    if (typeof subject !== 'string') return null;
    return { source, event, subject };
  } catch {
    return null;
  }
}

export interface DispatcherOptions {
  owner: string;
  repo: string;
  /** Returns a fresh-enough installation token; see `@the40thieves/github`. */
  token: () => Promise<string>;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Sends one `repository_dispatch` of type `rebuild` to the hub repository. `deploy.yml` listens
 * for that type; the payload names what changed so the deploy log says why it ran.
 */
export function createGitHubDispatcher(options: DispatcherOptions): Send {
  const { owner, repo, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return async (trigger) => {
    const response = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
        'user-agent': 'the40thieves-rebuild-dispatch (https://the40thieves.dev)',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'rebuild',
        client_payload: { ...trigger, at: new Date(now()).toISOString() },
      }),
    });
    if (response.status !== 204) {
      throw new Error(
        `repository_dispatch to ${owner}/${repo} failed: HTTP ${String(response.status)}`,
      );
    }
  };
}
