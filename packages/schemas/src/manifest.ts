import { z } from 'zod';

import { INSTALL_CLIENTS } from './hub.ts';
import { releaseSchema } from './project.ts';

/** Which file in which repository at which commit an item was derived from. */
export const provenanceSchema = z
  .object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/name'),
    path: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

/** One install snippet per client the product page renders; null where hub.json has none. */
export const manifestInstallSchema = z
  .object(
    Object.fromEntries(INSTALL_CLIENTS.map((client) => [client, z.string().min(1).nullable()])) as {
      [K in (typeof INSTALL_CLIENTS)[number]]: z.ZodNullable<z.ZodString>;
    },
  )
  .strict();

export const manifestReleaseSchema = releaseSchema
  .pick({ tag: true, published_at: true, url: true })
  .extend({
    /**
     * Release notes as written on GitHub (Markdown), cut at the byte cap so the manifest stays
     * small. Data, not instructions: every surface labels them as untrusted.
     */
    notes: z.string().nullable(),
    notes_truncated: z.boolean(),
  })
  .strict();

export const manifestProjectSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    tagline: z.string().min(1),
    /** The repository description as GitHub shows it, or null. */
    description: z.string().nullable(),
    listed: z.boolean(),
    repo: z.url(),
    /** Site path of the product page, or null for an unlisted project. */
    page: z
      .string()
      .regex(/^\/[a-z0-9-]+\/$/)
      .nullable(),
    release: manifestReleaseSchema.nullable(),
    install: manifestInstallSchema,
    /** The docs site on the hub (`https://the40thieves.dev/<slug>/docs/`), or null. */
    docs: z.url().nullable(),
    source: provenanceSchema,
  })
  .strict();

export const manifestToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    project: z.string().min(1),
    /** null until a source file states it; the MCPB manifest does not. */
    read_only: z.boolean().nullable(),
    input_schema: z.record(z.string(), z.unknown()).nullable(),
    source: provenanceSchema,
  })
  .strict();

/** One changelog post as the `/changelog/` page shows it (P2-11), summary only. */
export const manifestChangelogEntrySchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    /** Manifest project slug the post is about, or null. */
    project: z.string().nullable(),
    published_at: z.iso.datetime(),
    url: z.url(),
  })
  .strict();

/** A tool the hub's own `/mcp` endpoint serves (P3-S1). Nothing else is callable there. */
export const manifestMcpToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1),
    read_only: z.literal(true),
  })
  .strict();

/**
 * The deny-by-default allowlist every surface renders from: pages, `llms.txt`, `/mcp`,
 * WebMCP, JSON-LD, the org README and the SVG cards. Public at `/manifest.json`.
 */
export const manifestSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.iso.datetime(),
    /** Hub repo commit the build ran from, or null outside git. */
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    site: z.url(),
    projects: z.array(manifestProjectSchema),
    /** Every site path the build emits, trailing slash, sorted. */
    pages: z.array(z.string().regex(/^\/(?:[a-z0-9-]+\/)*$/)),
    tools: z.array(manifestToolSchema),
    /** Changelog posts, newest first. */
    changelog: z.array(manifestChangelogEntrySchema),
    /** The hub's MCP endpoint and the tools it serves, in `tools/list` order. */
    mcp: z
      .object({
        endpoint: z.url(),
        tools: z.array(manifestMcpToolSchema),
      })
      .strict(),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestProject = z.infer<typeof manifestProjectSchema>;
export type ManifestRelease = z.infer<typeof manifestReleaseSchema>;
export type ManifestInstall = z.infer<typeof manifestInstallSchema>;
export type ManifestTool = z.infer<typeof manifestToolSchema>;
export type ManifestChangelogEntry = z.infer<typeof manifestChangelogEntrySchema>;
export type ManifestMcpTool = z.infer<typeof manifestMcpToolSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
