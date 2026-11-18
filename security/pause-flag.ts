/**
 * The kill switch (P4-S5): one key in the `FLAGS` KV namespace pauses the relay Worker and the
 * `/alexandria/try/` page together. Both Workers import this file, so they read the same key by
 * the same rule.
 *
 * Pause: write a value to `relay-paused` that is not empty and not an "off" word (`0`, `false`,
 * `off`, `no`). Resume: delete the key.
 * A read is cached for 30 seconds where it is made (the KV minimum), so a write takes effect
 * everywhere within about that long.
 */
export const PAUSE_KEY = 'relay-paused';

/** The shortest `cacheTtl` Workers KV accepts. */
export const PAUSE_CACHE_TTL_SECONDS = 30;

/** `Retry-After` on every paused answer: a pause is an operator decision, not a blip. */
export const PAUSE_RETRY_AFTER_SECONDS = 300;

/** The part of a KV namespace the check uses. */
export interface FlagStore {
  get(key: string, options: { cacheTtl: number }): Promise<string | null>;
}

const OFF_WORDS = new Set(['', '0', 'false', 'off', 'no']);

/** True for any stored value except a missing key or an "off" word (`0`, `false`, `off`, `no`). */
export function isPausedValue(value: string | null): boolean {
  if (value === null) return false;
  return !OFF_WORDS.has(value.trim().toLowerCase());
}

/**
 * A check that reads the flag once per call. Without a store it is always false. When a read
 * fails it answers the last value it saw (false before the first read) and reports the error:
 * a KV outage must not pause the site, and must not resume a site that was paused.
 */
export function createPauseCheck(
  store: FlagStore | undefined,
  onError: (error: unknown) => void = () => undefined,
): () => Promise<boolean> {
  let last = false;
  // Reads overlap: requests share one check. `last` only moves forward, so a slow older read
  // that lands after a newer one cannot put back the value the newer one replaced.
  let started = 0;
  let committed = 0;
  return async () => {
    if (store === undefined) return false;
    started += 1;
    const read = started;
    try {
      const value = isPausedValue(
        await store.get(PAUSE_KEY, { cacheTtl: PAUSE_CACHE_TTL_SECONDS }),
      );
      if (read > committed) {
        committed = read;
        last = value;
      }
      return value;
    } catch (error) {
      onError(error);
      return last;
    }
  };
}
