import { z } from 'zod';

import { hubJsonSchema } from './hub.ts';

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-character commit SHA');

export const releaseSchema = z
  .object({
    tag: z.string().min(1),
    name: z.string().nullable(),
    published_at: z.iso.datetime(),
    /** Release body as written on GitHub (Markdown). Rendered through the sanitizer only. */
    body: z.string().nullable(),
    url: z.url(),
    prerelease: z.boolean(),
  })
  .strict();

/** The subset of an MCPB `manifest.json` the manifest reads. Unknown keys are kept. */
export const mcpbManifestSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/** One repository as the `projects` collection stores it. */
export const projectEntrySchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().nullable(),
    url: z.url(),
    homepage: z.url().nullable(),
    stars: z.number().int().nonnegative(),
    topics: z.array(z.string()),
    /** Topics minus hub control topics; the taxonomy the pages group by. */
    taxonomy: z.array(z.string()),
    license: z.string().nullable(),
    default_branch: z.string().min(1),
    head: z.object({ sha, committed_at: z.iso.datetime() }).strict(),
    release: releaseSchema.nullable(),
    readme: z.string().nullable(),
    hub: hubJsonSchema.nullable(),
    /** Where `hub` came from: the repo file or the hub-side fallback. */
    hub_source: z.enum(['repo', 'hub']).nullable(),
    /** MCP registry `server.json`, kept verbatim for Phase 3. */
    server: z.unknown().nullable(),
    mcpb: mcpbManifestSchema.nullable(),
    listed: z.boolean(),
    fetched_at: z.iso.datetime(),
  })
  .strict();

export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type Release = z.infer<typeof releaseSchema>;
