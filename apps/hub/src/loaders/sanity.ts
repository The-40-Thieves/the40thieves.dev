import { readFileSync } from 'node:fs';

import {
  changelogPostSchema,
  spotlightSchema,
  type ChangelogPost,
  type Spotlight,
} from '@the40thieves/schemas';
import type { Loader, LoaderContext } from 'astro/loaders';
import { z } from 'zod';

/** Dated API version, as Sanity asks; bump deliberately, never to `today`. */
export const SANITY_API_VERSION = '2026-05-09';

export type SanityType = 'spotlight' | 'changelogPost';

const FIELDS = [
  '"id": _id',
  'title',
  '"slug": slug.current',
  'summary',
  'body',
  'project',
  '"published_at": publishedAt',
  '"updated_at": _updatedAt',
];

/**
 * One query per type per build. Drafts never match: the request runs with the `published`
 * perspective, and `defined(slug.current)` drops a document saved without a slug.
 */
function query(type: SanityType, extraFields: string[] = []): string {
  const fields = [...FIELDS, ...extraFields].join(', ');
  return `*[_type == "${type}" && defined(slug.current)] | order(publishedAt desc) { ${fields} }`;
}

export const QUERIES: Record<SanityType, string> = {
  // The alt text lives beside the asset on the document; the projection folds it in.
  spotlight: query('spotlight', [
    'link',
    '"image": image { public_id, format, width, height, "alt": ^.imageAlt }',
  ]),
  changelogPost: query('changelogPost'),
};

const SCHEMAS = { spotlight: spotlightSchema, changelogPost: changelogPostSchema } as const;

export interface SanityOptions {
  projectId: string;
  dataset: string;
  /** Viewer token. Needed once the dataset is private; harmless on a public one. */
  token: string | undefined;
}

export interface SanityLoaderOptions extends SanityOptions {
  /** `HUB_SANITY_FIXTURE`: a recorded file keyed by type, for offline builds and tests. */
  fixturePath?: string | undefined;
}

/** The live API (not the CDN): a build wants what was published a minute ago. */
export function queryUrl(options: SanityOptions, type: SanityType): string {
  const url = new URL(
    `https://${options.projectId}.api.sanity.io/v${SANITY_API_VERSION}/data/query/${options.dataset}`,
  );
  url.searchParams.set('query', QUERIES[type]);
  url.searchParams.set('perspective', 'published');
  return url.href;
}

const resultSchema = z.object({ result: z.array(z.unknown()) }).loose();

export async function fetchDocuments(options: SanityOptions, type: SanityType): Promise<unknown[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(queryUrl(options, type), { headers });
  if (!response.ok) {
    throw new Error(
      `Sanity query for ${type} in dataset ${options.dataset} failed: HTTP ${String(response.status)} ` +
        (await response.text()).slice(0, 200),
    );
  }
  const parsed = resultSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Sanity response drifted from the query\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.result;
}

export function readFixture(path: string, type: SanityType): unknown[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const documents = raw[type];
  if (!Array.isArray(documents)) {
    throw new Error(`${path}: no "${type}" array in the Sanity fixture`);
  }
  return documents;
}

type EntryOf<T extends SanityType> = T extends 'spotlight' ? Spotlight : ChangelogPost;

/** Validates every projected document; one bad document fails the build with its field named. */
export function toEntries<T extends SanityType>(type: T, documents: unknown[]): EntryOf<T>[] {
  const seen = new Map<string, string>();
  return documents.map((document, index) => {
    const result = SCHEMAS[type].safeParse(document);
    if (!result.success) {
      throw new Error(
        `${type} document ${String(index)} failed validation\n${z.prettifyError(result.error)}`,
      );
    }
    const entry = result.data as EntryOf<T>;
    const other = seen.get(entry.slug);
    if (other !== undefined) {
      throw new Error(
        `${type} documents ${other} and ${entry.id} share the slug "${entry.slug}"; slugs must be unique`,
      );
    }
    seen.set(entry.slug, entry.id);
    return entry;
  });
}

interface SanityLoader<S extends z.ZodType> {
  name: string;
  schema: S;
  load: (context: LoaderContext) => Promise<void>;
}

/** One factory per type so Astro infers each collection's entry type from its own schema. */
function loader<S extends z.ZodType>(
  type: SanityType,
  schema: S,
  options: SanityLoaderOptions,
): SanityLoader<S> {
  return {
    name: `sanity-${type}-loader`,
    schema,
    load: async (context) => {
      const { store, logger } = context;
      logger.info(
        options.fixturePath
          ? `Loading ${type} documents from fixture ${options.fixturePath}`
          : `Loading ${type} documents from Sanity ${options.projectId}/${options.dataset}`,
      );
      const documents = options.fixturePath
        ? readFixture(options.fixturePath, type)
        : await fetchDocuments(options, type);
      const entries = toEntries(type, documents);
      store.clear();
      for (const entry of entries) {
        const data = await context.parseData({ id: entry.slug, data: entry });
        store.set({ id: entry.slug, data, digest: context.generateDigest(entry) });
      }
      logger.info(`${String(entries.length)} ${type} documents`);
    },
  } satisfies Loader;
}

export const spotlightLoader = (options: SanityLoaderOptions) =>
  loader('spotlight', spotlightSchema, options);

export const changelogLoader = (options: SanityLoaderOptions) =>
  loader('changelogPost', changelogPostSchema, options);
