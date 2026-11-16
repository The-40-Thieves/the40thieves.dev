import { loadDocsIndex, type LoadedDocsIndex } from '@the40thieves/manifest';
import { manifestSchema, type Manifest } from '@the40thieves/schemas';
import { z } from 'zod';

/** The read side of the KV binding; the fake in the tests implements the same shape. */
export interface KvReader {
  get(key: string): Promise<string | null>;
}

/** Everything the tools read: the two documents the hub build emits and the deploy uploads. */
export interface McpData {
  manifest: Manifest;
  docs: LoadedDocsIndex;
}

export const MANIFEST_KEY = 'manifest.json';
export const DOCS_INDEX_KEY = 'docs-index.json';
/** How long one isolate keeps the parsed documents before reading KV again. */
export const DATA_TTL_MS = 60_000;

/** KV has no usable documents yet (first deploy) or an upload that does not validate. */
export class DataError extends Error {
  override readonly name = 'DataError';
}

let cache: { data: McpData; expiresAt: number } | undefined;
let pending: Promise<McpData> | undefined;

async function readData(kv: KvReader): Promise<McpData> {
  const [manifestText, docsText] = await Promise.all([
    kv.get(MANIFEST_KEY),
    kv.get(DOCS_INDEX_KEY),
  ]);
  if (manifestText === null) throw new DataError(`${MANIFEST_KEY} is not in KV`);
  if (docsText === null) throw new DataError(`${DOCS_INDEX_KEY} is not in KV`);
  const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
  if (!parsed.success) {
    throw new DataError(`${MANIFEST_KEY} is not valid\n${z.prettifyError(parsed.error)}`);
  }
  let docs: LoadedDocsIndex;
  try {
    docs = loadDocsIndex(JSON.parse(docsText));
  } catch (error) {
    throw new DataError(`${DOCS_INDEX_KEY} is not valid`, { cause: error });
  }
  return { manifest: parsed.data, docs };
}

/**
 * The manifest and the docs index, parsed once per isolate and refreshed after `DATA_TTL_MS`.
 * Concurrent first calls share one read. A failed read is not cached, so the next request
 * tries KV again.
 */
export function loadData(kv: KvReader, now = Date.now()): Promise<McpData> {
  if (cache && cache.expiresAt > now) return Promise.resolve(cache.data);
  pending ??= readData(kv)
    .then((data) => {
      cache = { data, expiresAt: now + DATA_TTL_MS };
      return data;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

/** Tests only: forget the cached documents. */
export function resetDataCache(): void {
  cache = undefined;
  pending = undefined;
}
