import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { HUB_MCP_TOOLS } from '@the40thieves/manifest';
import {
  INSTALL_CLIENTS,
  manifestChangelogEntrySchema,
  manifestProjectSchema,
  manifestReleaseSchema,
  type ManifestProject,
  type ManifestRelease,
} from '@the40thieves/schemas';
import { z } from 'zod';

import { CursorError, jsonBytes, MAX_PAGE_BYTES, page, sliceText } from './caps.ts';
import type { McpData } from './data.ts';
import { searchDocs, searchProjects } from './search.ts';
import { parseVersion, compareVersions } from './semver.ts';
import { validateConfig } from './validate.ts';

/**
 * The nine read-only tools (P3-S1). Every result is `structuredContent` under the page
 * cap, mirrored as JSON text for clients that read only `content`. Source text (release notes,
 * docs) travels under `untrusted: true`. Validation errors from the input schemas are JSON-RPC
 * errors; everything the tool itself refuses (unknown slug, bad cursor) is `isError` with a
 * message.
 */
type TextResult = CallToolResult;

function ok(structured: Record<string, unknown>): TextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function fail(message: string): TextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const descriptions = new Map(HUB_MCP_TOOLS.map((tool) => [tool.name, tool.description]));

function describe(name: string): string {
  const description = descriptions.get(name);
  if (description === undefined) throw new Error(`${name} is not a manifest tool`);
  return description;
}

const slugSchema = z.string().min(1).max(100);
const querySchema = z.string().min(1).max(200);
const cursorSchema = z.string().max(200).optional();
const limitSchema = z.number().int().min(1).max(20).optional();

/** Source text as the tools hand it out: data, never an instruction. */
const notesSchema = z.object({
  text: z.string().nullable(),
  untrusted: z.literal(true),
  truncated: z.boolean(),
});

const projectOutputSchema = manifestProjectSchema.omit({ release: true }).extend({
  release: manifestReleaseSchema
    .omit({ notes: true, notes_truncated: true })
    .extend({ notes: notesSchema })
    .nullable(),
});

function notesOf(release: ManifestRelease): z.infer<typeof notesSchema> {
  return { text: release.notes, untrusted: true, truncated: release.notes_truncated };
}

function projectOut(project: ManifestProject): z.infer<typeof projectOutputSchema> {
  const { release, ...rest } = project;
  if (release === null) return { ...rest, release: null };
  return {
    ...rest,
    release: {
      tag: release.tag,
      published_at: release.published_at,
      url: release.url,
      notes: notesOf(release),
    },
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The JSON bytes a read_doc page spends on everything but the text. */
const READ_DOC_ENVELOPE = jsonBytes({
  path: 'x'.repeat(100),
  title: 'x'.repeat(200),
  text: '',
  untrusted: true,
  next_cursor: 'x'.repeat(40),
});

export function registerTools(server: McpServer, data: McpData): void {
  const { manifest, docs } = data;
  const projects = new Map(manifest.projects.map((project) => [project.slug, project]));
  const find = (slug: string): ManifestProject | undefined => projects.get(slug);

  server.registerTool(
    'search_projects',
    {
      description: describe('search_projects'),
      inputSchema: z.object({ query: querySchema, limit: limitSchema, cursor: cursorSchema }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            slug: z.string(),
            name: z.string(),
            tagline: z.string(),
            page: z.string(),
            repo: z.string(),
            score: z.number(),
          }),
        ),
        next_cursor: z.string().nullable(),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit, cursor }) => {
      const hits = searchProjects(manifest, query).slice(0, limit ?? 10);
      try {
        const { items, next_cursor } = page(hits, cursor);
        return ok({ results: items, next_cursor });
      } catch (error) {
        if (error instanceof CursorError) return fail(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    'compare_projects',
    {
      description: describe('compare_projects'),
      inputSchema: z.object({ slugs: z.array(slugSchema).min(2).max(5) }),
      outputSchema: z.object({
        projects: z.array(
          z.object({
            slug: z.string(),
            name: z.string(),
            tagline: z.string(),
            release: z.object({ tag: z.string(), published_at: z.string() }).nullable(),
            install: z.object({ shell: z.string().nullable() }),
            docs: z.string().nullable(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    ({ slugs }) => {
      const unknown = slugs.filter((slug) => !find(slug));
      if (unknown.length > 0) return fail(`unknown project: ${unknown.join(', ')}`);
      return ok({
        projects: slugs.map((slug) => {
          const project = find(slug) as ManifestProject;
          return {
            slug: project.slug,
            name: project.name,
            tagline: project.tagline,
            release: project.release
              ? { tag: project.release.tag, published_at: project.release.published_at }
              : null,
            install: { shell: project.install.shell },
            docs: project.docs,
          };
        }),
      });
    },
  );

  server.registerTool(
    'get_project',
    {
      description: describe('get_project'),
      inputSchema: z.object({ slug: slugSchema }),
      outputSchema: projectOutputSchema,
      annotations: READ_ONLY,
    },
    ({ slug }) => {
      const project = find(slug);
      if (!project) return fail(`unknown project: ${slug}`);
      return ok(projectOut(project));
    },
  );

  server.registerTool(
    'get_install',
    {
      description: describe('get_install'),
      inputSchema: z.object({ slug: slugSchema, client: z.enum(INSTALL_CLIENTS) }),
      outputSchema: z.object({
        slug: z.string(),
        client: z.enum(INSTALL_CLIENTS),
        snippet: z.string(),
        format: z.enum(['shell', 'json']),
      }),
      annotations: READ_ONLY,
    },
    ({ slug, client }) => {
      const project = find(slug);
      if (!project) return fail(`unknown project: ${slug}`);
      const snippet = project.install[client];
      if (snippet === null) return fail(`${slug} publishes no ${client} install snippet`);
      const format = client === 'cursor' || client === 'vscode' ? 'json' : 'shell';
      return ok({ slug, client, snippet, format });
    },
  );

  server.registerTool(
    'latest_release',
    {
      description: describe('latest_release'),
      inputSchema: z.object({ slug: slugSchema }),
      outputSchema: z.object({
        slug: z.string(),
        tag: z.string(),
        published_at: z.string(),
        url: z.string(),
        notes: notesSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ slug }) => {
      const project = find(slug);
      if (!project) return fail(`unknown project: ${slug}`);
      const { release } = project;
      if (release === null) return fail(`${slug} has no release`);
      return ok({
        slug,
        tag: release.tag,
        published_at: release.published_at,
        url: release.url,
        notes: notesOf(release),
      });
    },
  );

  server.registerTool(
    'changelog_since',
    {
      description: describe('changelog_since'),
      inputSchema: z.object({
        slug: slugSchema.optional(),
        version: z.string().max(100).optional(),
        since: z.string().max(40).optional(),
      }),
      outputSchema: z.object({
        releases: z.array(
          z.object({
            slug: z.string(),
            tag: z.string(),
            published_at: z.string(),
            url: z.string(),
          }),
        ),
        posts: z.array(manifestChangelogEntrySchema),
        history: z.literal('latest-only'),
      }),
      annotations: READ_ONLY,
    },
    ({ slug, version, since }) => {
      if (slug !== undefined && !find(slug)) return fail(`unknown project: ${slug}`);
      if (version !== undefined && parseVersion(version) === null) {
        return fail(`version is not semver (MAJOR.MINOR.PATCH): ${version}`);
      }
      const after = since === undefined ? null : Date.parse(since);
      if (after !== null && Number.isNaN(after))
        return fail(`since is not an ISO date: ${String(since)}`);
      const releases = manifest.projects
        .filter((project) => slug === undefined || project.slug === slug)
        .flatMap((project) => {
          const { release } = project;
          if (release === null) return [];
          if (version !== undefined && compareVersions(release.tag, version) !== 1) return [];
          return [
            {
              slug: project.slug,
              tag: release.tag,
              published_at: release.published_at,
              url: release.url,
            },
          ];
        });
      const posts = manifest.changelog.filter(
        (post) =>
          (slug === undefined || post.project === slug) &&
          (after === null || Date.parse(post.published_at) >= after),
      );
      return ok({ releases, posts, history: 'latest-only' as const });
    },
  );

  server.registerTool(
    'search_docs',
    {
      description: describe('search_docs'),
      inputSchema: z.object({ query: querySchema, limit: limitSchema }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            path: z.string(),
            title: z.string(),
            snippet: z.string(),
            score: z.number(),
          }),
        ),
        untrusted: z.literal(true),
      }),
      annotations: READ_ONLY,
    },
    ({ query, limit }) =>
      ok({ results: searchDocs(docs, query, limit ?? 10), untrusted: true as const }),
  );

  server.registerTool(
    'read_doc',
    {
      description: describe('read_doc'),
      inputSchema: z.object({ path: z.string().min(1).max(200), cursor: cursorSchema }),
      outputSchema: z.object({
        path: z.string(),
        title: z.string(),
        text: z.string(),
        untrusted: z.literal(true),
        next_cursor: z.string().nullable(),
      }),
      annotations: READ_ONLY,
    },
    ({ path, cursor }) => {
      // The index is a map keyed by the exact published path; nothing else is ever looked up.
      const document = docs.documents.get(path);
      if (!document) return fail(`${path} is not in the index`);
      try {
        const { text, next_cursor } = sliceText(
          document.text,
          cursor,
          MAX_PAGE_BYTES - READ_DOC_ENVELOPE,
        );
        return ok({
          path: document.path,
          title: document.title,
          text,
          untrusted: true as const,
          next_cursor,
        });
      } catch (error) {
        if (error instanceof CursorError) return fail(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    'validate_config',
    {
      description: describe('validate_config'),
      inputSchema: z.object({
        slug: slugSchema,
        client: z.enum(['cursor', 'vscode']),
        config: z.union([z.string().max(20_000), z.record(z.string(), z.unknown())]),
      }),
      outputSchema: z.object({
        valid: z.boolean(),
        issues: z.array(z.object({ path: z.string(), message: z.string() })),
        expected: z.unknown(),
      }),
      annotations: READ_ONLY,
    },
    ({ slug, client, config }) => {
      const project = find(slug);
      if (!project) return fail(`unknown project: ${slug}`);
      const result = validateConfig(project, client, config);
      return ok({ ...result, expected: result.expected ?? null });
    },
  );
}
