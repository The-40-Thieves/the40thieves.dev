import MiniSearch, { type Options } from 'minisearch';
import { z } from 'zod';

/**
 * The build-time search index behind the `/mcp` tools `search_docs` and `read_doc` (P3-S1). Pagefind cannot run in workerd, so the hub build serialises a MiniSearch index over
 * the Markdown twins and the deploy uploads it to KV next to the manifest.
 */
export interface DocsDocument {
  /** The site path, which is also the MiniSearch id (`/codecalc.md`). */
  id: string;
  path: string;
  title: string;
  text: string;
}

export const docsIndexSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.iso.datetime(),
    /** Sorted by path. The text is what `read_doc` serves. */
    documents: z.array(
      z
        .object({
          id: z.string().min(1),
          path: z.string().regex(/^\/[A-Za-z0-9/_-]+\.md$/),
          title: z.string().min(1),
          text: z.string(),
        })
        .strict(),
    ),
    /** `MiniSearch.toJSON()` of the documents, loaded back with `DOCS_INDEX_OPTIONS`. */
    index: z.unknown(),
  })
  .strict();

export type DocsIndex = z.infer<typeof docsIndexSchema>;

/** The MiniSearch options the index was built with; loading needs the same ones. */
export const DOCS_INDEX_OPTIONS: Options<DocsDocument> = {
  idField: 'id',
  fields: ['title', 'text'],
  storeFields: ['path', 'title'],
  searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.1 },
};

/** The first level-one heading of a Markdown document, or its path when it has none. */
export function docTitle(path: string, text: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  return heading?.[1] ?? path;
}

export function buildDocsIndex(
  docs: readonly { path: string; text: string }[],
  generatedAt: string,
): DocsIndex {
  const documents: DocsDocument[] = [...docs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((doc) => ({
      id: doc.path,
      path: doc.path,
      title: docTitle(doc.path, doc.text),
      text: doc.text,
    }));
  const search = new MiniSearch<DocsDocument>(DOCS_INDEX_OPTIONS);
  search.addAll(documents);
  const index: DocsIndex = {
    version: 1,
    generated_at: generatedAt,
    documents,
    index: search.toJSON(),
  };
  return docsIndexSchema.parse(index);
}

export interface LoadedDocsIndex {
  generated_at: string;
  search: MiniSearch<DocsDocument>;
  documents: Map<string, DocsDocument>;
}

/** Validates a serialised index (from KV or a fixture) and rebuilds the searchable form. */
export function loadDocsIndex(raw: unknown): LoadedDocsIndex {
  const result = docsIndexSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`docs index is not valid\n${z.prettifyError(result.error)}`);
  }
  const { documents, index, generated_at } = result.data;
  return {
    generated_at,
    search: MiniSearch.loadJSON<DocsDocument>(JSON.stringify(index), DOCS_INDEX_OPTIONS),
    documents: new Map(documents.map((doc) => [doc.path, doc])),
  };
}
