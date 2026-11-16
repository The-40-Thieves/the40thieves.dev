import type { Store } from '../src/store.ts';

export class FakeClock {
  private at: number;

  constructor(at: number) {
    this.at = at;
  }

  now = (): number => this.at;

  advance(ms: number): void {
    this.at += ms;
  }
}

/** In-memory stand-in for the KV binding, with TTLs driven by a fake clock. */
export class FakeStore implements Store {
  readonly entries = new Map<string, { value: string; expiresAt: number | null }>();
  readonly puts: string[] = [];
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push(key);
    const ttl = options?.expirationTtl;
    this.entries.set(key, {
      value,
      expiresAt: ttl === undefined ? null : this.clock.now() + ttl * 1000,
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
