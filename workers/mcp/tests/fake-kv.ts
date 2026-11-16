import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** In-memory stand-in for the read side of the KV binding. */
export class FakeKv {
  readonly entries = new Map<string, string>();
  readonly reads: string[] = [];

  set(key: string, value: string): this {
    this.entries.set(key, value);
    return this;
  }

  get(key: string): Promise<string | null> {
    this.reads.push(key);
    return Promise.resolve(this.entries.get(key) ?? null);
  }
}

/** Counts calls per key the way the Rate Limiting binding does, exactly rather than approximately. */
export class FakeRateLimiter {
  readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(max = 100) {
    this.max = max;
  }

  limit(options: { key: string }): Promise<{ success: boolean }> {
    const count = (this.counts.get(options.key) ?? 0) + 1;
    this.counts.set(options.key, count);
    return Promise.resolve({ success: count <= this.max });
  }
}

export function fixture(name: 'manifest.json' | 'docs-index.json'): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

/** A KV with both documents the deploy uploads. */
export function loadedKv(): FakeKv {
  return new FakeKv()
    .set('manifest.json', fixture('manifest.json'))
    .set('docs-index.json', fixture('docs-index.json'));
}

export function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}
