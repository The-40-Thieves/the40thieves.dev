import type { TryResult } from './sources.ts';

/**
 * The result cache (P4-S4): recent searches kept in the origin private file system, so a
 * repeat search answers from the device. An entry holds the query, the source names and the
 * results; it never holds a key, a relay session or a model answer. Entries expire after a day
 * and the oldest go first once the tier's limit is reached.
 */

export const CACHE_DIR = 'alexandria-try';
const INDEX_FILE = 'index.json';
export const CACHE_TTL_MS = 86_400_000;

export interface CacheEntry {
  query: string;
  sources: string[];
  perSource: number;
  at: number;
  results: TryResult[];
}

/** The file system the cache writes to: OPFS in the browser, a Map in tests. */
export interface CacheFiles {
  read(name: string): Promise<string | null>;
  write(name: string, body: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The cache id for a search: a SHA-256 of what decides its results. */
export async function cacheId(
  query: string,
  sources: string[],
  perSource: number,
): Promise<string> {
  const material = JSON.stringify([query.trim().toLowerCase(), [...sources].sort(), perSource]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Index = { id: string; at: number }[];

async function readIndex(files: CacheFiles): Promise<Index> {
  const raw = await files.read(INDEX_FILE);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (row): row is { id: string; at: number } =>
            typeof (row as { id?: unknown }).id === 'string' &&
            typeof (row as { at?: unknown }).at === 'number',
        )
      : [];
  } catch {
    return [];
  }
}

export class ResultCache {
  constructor(
    private readonly files: CacheFiles,
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(query: string, sources: string[], perSource: number): Promise<CacheEntry | null> {
    if (this.limit === 0) return null;
    const id = await cacheId(query, sources, perSource);
    const raw = await this.files.read(`${id}.json`);
    if (raw === null) return null;
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      if (this.now() - entry.at > CACHE_TTL_MS || !Array.isArray(entry.results)) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async put(
    query: string,
    sources: string[],
    perSource: number,
    results: TryResult[],
  ): Promise<void> {
    if (this.limit === 0) return;
    const id = await cacheId(query, sources, perSource);
    const at = this.now();
    const entry: CacheEntry = {
      query: query.trim(),
      sources: [...sources].sort(),
      perSource,
      at,
      results,
    };
    await this.files.write(`${id}.json`, JSON.stringify(entry));
    const index = (await readIndex(this.files)).filter((row) => row.id !== id);
    index.push({ id, at });
    index.sort((a, b) => b.at - a.at);
    const keep = index.filter((row) => at - row.at <= CACHE_TTL_MS).slice(0, this.limit);
    const kept = new Set(keep.map((row) => row.id));
    for (const row of index) if (!kept.has(row.id)) await this.files.remove(`${row.id}.json`);
    await this.files.write(INDEX_FILE, JSON.stringify(keep));
  }

  /** Remove every entry this cache knows about. */
  async clear(): Promise<void> {
    for (const row of await readIndex(this.files)) await this.files.remove(`${row.id}.json`);
    await this.files.remove(INDEX_FILE);
  }
}

/** OPFS-backed files, or null when the browser has no OPFS (or refuses it). */
export async function opfsFiles(): Promise<CacheFiles | null> {
  try {
    if (typeof navigator === 'undefined' || !('storage' in navigator)) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    return {
      async read(name) {
        try {
          return await (await (await dir.getFileHandle(name)).getFile()).text();
        } catch {
          return null;
        }
      },
      async write(name, body) {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(body);
        await writable.close();
      },
      async remove(name) {
        try {
          await dir.removeEntry(name);
        } catch {
          // Already gone.
        }
      },
    };
  } catch {
    return null;
  }
}

/** A Map-backed `CacheFiles`, for tests. */
export function memoryFiles(): CacheFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (name) => Promise.resolve(files.get(name) ?? null),
    write: (name, body) => {
      files.set(name, body);
      return Promise.resolve();
    },
    remove: (name) => {
      files.delete(name);
      return Promise.resolve();
    },
  };
}
