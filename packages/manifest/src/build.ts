import {
  INSTALL_CLIENTS,
  manifestSchema,
  type ChangelogPost,
  type Manifest,
  type ManifestChangelogEntry,
  type ManifestInstall,
  type ManifestProject,
  type ManifestRelease,
  type ManifestTool,
  type ProjectEntry,
  type Provenance,
  type Release,
} from '@the40thieves/schemas';
import { z } from 'zod';

import { HUB_MCP_TOOLS } from './mcp-tools.ts';

export const ORG = 'The-40-Thieves';

/** Release notes in the manifest stop here, so one long release cannot bloat every surface. */
export const MAX_RELEASE_NOTES_BYTES = 8192;

/** The longest prefix of `text` that encodes to at most `max` bytes, cut on a character. */
export function truncateBytes(text: string, max: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return { text, truncated: false };
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > max) break;
    out += char;
    bytes += size;
  }
  return { text: out, truncated: true };
}
export const HUB_REPO = `${ORG}/the40thieves.dev`;

export interface BuildInfo {
  /** ISO timestamp, fixed once per build. */
  generatedAt: string;
  /** Hub repo commit the build runs from. */
  commit: string;
  site: string;
}

/** Where a project's page copy came from, so the page can say so. */
export function hubProvenance(entry: ProjectEntry, build: BuildInfo): Provenance {
  if (entry.hub_source === 'repo') {
    return { repo: `${ORG}/${entry.name}`, path: 'hub.json', sha: entry.head.sha };
  }
  if (entry.hub_source === 'hub') {
    return { repo: HUB_REPO, path: `apps/hub/content/hub/${entry.name}.json`, sha: build.commit };
  }
  return { repo: `${ORG}/${entry.name}`, path: 'README.md', sha: entry.head.sha };
}

export function pagePath(entry: Pick<ProjectEntry, 'slug' | 'listed'>): string | null {
  return entry.listed ? `/${entry.slug}/` : null;
}

/**
 * The Markdown twin of a page path (P3-S2): `/` is `/index.md`, `/codecalc/` is
 * `/codecalc.md`, `/codecalc/docs/` is `/codecalc/docs.md`. Total: every page has one.
 */
export function twinPath(page: string): string {
  if (page === '/') return '/index.md';
  return `${page.replace(/\/$/, '')}.md`;
}

function releaseFor(release: Release): ManifestRelease {
  const notes = release.body ? truncateBytes(release.body, MAX_RELEASE_NOTES_BYTES) : null;
  return {
    tag: release.tag,
    published_at: release.published_at,
    url: release.url,
    notes: notes?.text ?? null,
    notes_truncated: notes?.truncated ?? false,
  };
}

function installFor(entry: ProjectEntry): ManifestInstall {
  return Object.fromEntries(
    INSTALL_CLIENTS.map((client) => [client, entry.hub?.install[client] ?? null]),
  ) as ManifestInstall;
}

function projectFor(entry: ProjectEntry, build: BuildInfo): ManifestProject {
  return {
    slug: entry.slug,
    name: entry.name,
    tagline: entry.hub?.tagline ?? entry.description ?? entry.name,
    description: entry.description,
    listed: entry.listed,
    repo: entry.url,
    page: pagePath(entry),
    release: entry.release ? releaseFor(entry.release) : null,
    install: installFor(entry),
    docs:
      entry.hub?.docs_url ?? (entry.hub?.docs_site ? `${build.site}/${entry.slug}/docs/` : null),
    source: hubProvenance(entry, build),
  };
}

function changelogFor(posts: ChangelogPost[], build: BuildInfo): ManifestChangelogEntry[] {
  return [...posts]
    .sort((a, b) => b.published_at.localeCompare(a.published_at) || a.slug.localeCompare(b.slug))
    .map((post) => ({
      slug: post.slug,
      title: post.title,
      summary: post.summary,
      project: post.project,
      published_at: post.published_at,
      url: `${build.site}/changelog/`,
    }));
}

function toolsFor(entry: ProjectEntry): ManifestTool[] {
  const tools = entry.mcpb?.tools ?? [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    project: entry.slug,
    // The MCPB manifest states neither; Phase 3 reads them from the running server.
    read_only: null,
    input_schema: null,
    source: { repo: `${ORG}/${entry.name}`, path: 'mcpb/manifest.json', sha: entry.head.sha },
  }));
}

/** Site paths that exist independent of any project. */
export const STATIC_PAGES = [
  '/',
  '/404/',
  '/changelog/',
  '/alexandria/sources/',
  '/alexandria/try/',
  '/design/library/',
] as const;

/**
 * The allowlist every surface renders from. Deterministic for a given set of entries and
 * build info, so two builds of the same commit produce the same file.
 */
export function buildManifest(
  entries: ProjectEntry[],
  build: BuildInfo,
  posts: ChangelogPost[] = [],
): Manifest {
  const sorted = [...entries].sort((a, b) => a.slug.localeCompare(b.slug));
  const pages = [...STATIC_PAGES, ...sorted.map(pagePath).filter((p): p is string => p !== null)];
  const manifest: Manifest = {
    version: 1,
    generated_at: build.generatedAt,
    commit: build.commit,
    site: build.site,
    projects: sorted.map((entry) => projectFor(entry, build)),
    pages: [...new Set(pages)].sort(),
    tools: sorted.flatMap(toolsFor),
    changelog: changelogFor(posts, build),
    mcp: { endpoint: `${build.site}/mcp`, tools: [...HUB_MCP_TOOLS] },
  };
  const result = manifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(`manifest failed its own schema\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** JSON Schema for `manifest.json`, published next to it so consumers can validate. */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(manifestSchema, { target: 'draft-2020-12' });
}
