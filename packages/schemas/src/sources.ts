import { z } from 'zod';

/**
 * `data/sources.json` (P4-S1): the routing matrix for alexandria-mcp's sources. The probe
 * (`scripts/probe-sources.ts`) writes it, the `/alexandria/sources/` page renders it, the relay
 * (P4-S2) takes its host allowlist from it, and the BYOK app (P4-S4) picks a route per source.
 */

/** Where a search for the source runs. Exactly one per source. */
export const SOURCE_ROUTES = [
  // The browser calls the source's API itself (CORS allows this origin); a key, when the source
  // wants one, is the visitor's and never leaves the browser.
  'browser-direct',
  // The browser calls relay.the40thieves.dev, which forwards the request (and the visitor's key,
  // when there is one) to a host that does not allow this origin.
  'visitor-key-relay',
  // The relay holds an operator key with a daily cap (P4-S3) for a keyed source that does
  // not allow this origin.
  'quota-relay',
  // Only alexandria-mcp itself serves the source: remote MCP servers and scraped sites.
  'mcp-only',
] as const;
export type SourceRoute = (typeof SOURCE_ROUTES)[number];

/** Upstream's adapter kinds (`src/sources/registry.ts` in alexandria-mcp). */
export const SOURCE_KINDS = ['rest', 'hub', 'rss', 'mcp', 'scrape'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What the probe saw: `unknown` when no request reached the source's host. */
export const CORS_VERDICTS = ['open', 'closed', 'unknown'] as const;
export type CorsVerdict = (typeof CORS_VERDICTS)[number];

/** Upstream's ingest policy, carried through as the one terms fact it declares per source. */
export const INGEST_POLICIES = ['allowed', 'attribution', 'timeboxed', 'forbidden'] as const;
export type IngestPolicy = (typeof INGEST_POLICIES)[number];

const nameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'a source name is lowercase letters, digits, _ or -');

export const sourceKeySchema = z
  .object({
    /** The environment variable upstream reads the key from. */
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** How upstream sends it: a query parameter, a named header or a Bearer token. */
    type: z.enum(['query', 'header', 'bearer']),
    /** Upstream's declared daily request cap for one key, when it declares one. */
    daily_cap: z.int().positive().nullable(),
  })
  .strict();

export const sourceEntrySchema = z
  .object({
    name: nameSchema,
    kind: z.enum(SOURCE_KINDS),
    cluster: nameSchema,
    freshness: z.enum(['realtime', 'daily', 'static']),
    description: z.string().trim().min(1),
    /** `null` when the source works without a key. */
    key: sourceKeySchema.nullable(),
    cors: z.enum(CORS_VERDICTS),
    /** Every host the adapter contacted, sorted; the relay allowlist is their union. */
    hosts: z.array(z.string().min(1)),
    terms: z
      .object({
        /** The source's homepage, where its terms live. */
        url: z.url(),
        ingest: z.enum(INGEST_POLICIES),
      })
      .strict(),
    route: z.enum(SOURCE_ROUTES),
    probe: z
      .object({
        /** `ok`: a response was read; `failed`: none was; `skipped`: the kind is not probed. */
        status: z.enum(['ok', 'failed', 'skipped']),
        detail: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const SOURCES_SCHEMA_ID = 'https://the40thieves.dev/schemas/sources.json';

export const sourcesFileSchema = z
  .object({
    $schema: z.literal(SOURCES_SCHEMA_ID),
    version: z.literal(1),
    /** The origin the probe sent; the CORS verdicts hold for it alone. */
    origin: z.url(),
    upstream: z
      .object({
        repo: z.literal('The-40-Thieves/alexandria-mcp'),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        sources: z.int().nonnegative(),
      })
      .strict(),
    routes: z.object(
      Object.fromEntries(SOURCE_ROUTES.map((route) => [route, z.int().nonnegative()])) as Record<
        SourceRoute,
        z.ZodInt
      >,
    ),
    sources: z.array(sourceEntrySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (file.upstream.sources !== file.sources.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['upstream', 'sources'],
        message: `upstream.sources is ${String(file.upstream.sources)} but there are ${String(file.sources.length)} entries`,
      });
    }
    const names = file.sources.map((source) => source.name);
    const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en'));
    if (names.length !== sorted.length || names.some((name, i) => name !== sorted[i])) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'sources must be unique and sorted by name',
      });
    }
    for (const route of SOURCE_ROUTES) {
      const actual = file.sources.filter((source) => source.route === route).length;
      if (file.routes[route] !== actual) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', route],
          message: `routes.${route} is ${String(file.routes[route])} but ${String(actual)} entries have that route`,
        });
      }
    }
  });

export type SourceKey = z.infer<typeof sourceKeySchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type SourcesFile = z.infer<typeof sourcesFileSchema>;

/** The JSON Schema served at `/schemas/sources.json`, so consumers can validate the file. */
export function sourcesJsonSchemaDocument(): Record<string, unknown> {
  const generated = z.toJSONSchema(sourcesFileSchema, { target: 'draft-2020-12' });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SOURCES_SCHEMA_ID,
    title: 'the40thieves.dev sources.json',
    description:
      'Routing matrix for alexandria-mcp sources: one route per source (browser-direct, visitor-key-relay, quota-relay or mcp-only), its CORS verdict, key requirement, hosts and terms link.',
    ...generated,
  };
}
