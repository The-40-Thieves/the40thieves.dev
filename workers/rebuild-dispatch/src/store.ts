/**
 * The slice of a KV namespace the Worker uses: string values with an optional TTL. Keeping it
 * this small lets the tests run against an in-memory map and keeps KV's eventual consistency
 * the only consistency model the code has to reason about.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
