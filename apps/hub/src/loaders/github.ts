import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HUB_META_KEYS,
  hubJsonSchema,
  mcpbManifestSchema,
  projectEntrySchema,
  toSlug,
  type HubJson,
  type ProjectEntry,
} from '@the40thieves/schemas';
import type { Loader } from 'astro/loaders';
import { z } from 'zod';

/** A repository carrying this topic never reaches the site. */
export const HUB_EXCLUDE_TOPIC = 'hub-exclude';

/**
 * One query per build. Measured on 2026-11-02 against the live org: cost 1 point of the
 * 5,000-point hourly budget (GraphQL charges per connection page, and this is one page).
 */
export const ORGANIZATION_QUERY = /* GraphQL */ `
  query Hub($org: String!) {
    organization(login: $org) {
      repositories(
        first: 100
        privacy: PUBLIC
        isFork: false
        isArchived: false
        orderBy: { field: NAME, direction: ASC }
      ) {
        totalCount
        nodes {
          name
          description
          url
          homepageUrl
          stargazerCount
          licenseInfo {
            spdxId
          }
          repositoryTopics(first: 20) {
            nodes {
              topic {
                name
              }
            }
          }
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
                committedDate
              }
            }
          }
          latestRelease {
            tagName
            name
            publishedAt
            description
            url
            isPrerelease
          }
          readme: object(expression: "HEAD:README.md") {
            ... on Blob {
              text
            }
          }
          hub: object(expression: "HEAD:hub.json") {
            ... on Blob {
              text
            }
          }
          server: object(expression: "HEAD:server.json") {
            ... on Blob {
              text
            }
          }
          mcpb: object(expression: "HEAD:mcpb/manifest.json") {
            ... on Blob {
              text
            }
          }
        }
      }
    }
  }
`;

const blob = z.object({ text: z.string() }).nullable();

/** The exact shape the query above returns. Drift from GitHub fails here with a zod path. */
const repositoryNodeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  url: z.url(),
  homepageUrl: z.string().nullable(),
  stargazerCount: z.number().int().nonnegative(),
  licenseInfo: z.object({ spdxId: z.string().nullable() }).nullable(),
  repositoryTopics: z.object({
    nodes: z.array(z.object({ topic: z.object({ name: z.string() }) })),
  }),
  defaultBranchRef: z
    .object({
      name: z.string(),
      target: z.object({ oid: z.string(), committedDate: z.string() }),
    })
    .nullable(),
  latestRelease: z
    .object({
      tagName: z.string(),
      name: z.string().nullable(),
      publishedAt: z.string(),
      description: z.string().nullable(),
      url: z.url(),
      isPrerelease: z.boolean(),
    })
    .nullable(),
  readme: blob,
  hub: blob,
  server: blob,
  mcpb: blob,
});

export const organizationResponseSchema = z.object({
  data: z.object({
    organization: z.object({
      repositories: z.object({
        totalCount: z.number().int(),
        nodes: z.array(repositoryNodeSchema),
      }),
    }),
  }),
});

export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;
type RepositoryNode = z.infer<typeof repositoryNodeSchema>;

/** A hub-side `hub.json` read from `apps/hub/content/hub/<repo>.json`. */
export interface HubOverride {
  /** Repo-relative path, used in error messages. */
  file: string;
  raw: unknown;
}

export type HubOverrides = Map<string, HubOverride>;

/**
 * Read every `<repo>.json` under `dir`. The `$schema` and `$comment` keys are dropped before
 * validation so the files can explain themselves. Validation happens in `toEntries`, per repository.
 */
export function readHubOverrides(dir: string): HubOverrides {
  const overrides: HubOverrides = new Map();
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return overrides;
  }
  for (const name of files.sort()) {
    // Forward slashes on every OS: this string only ever appears in error messages.
    const file = `content/hub/${name}`;
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    overrides.set(name.slice(0, -'.json'.length), { file, raw: withoutMetaKeys(parsed) });
  }
  return overrides;
}

/** `$schema` and `$comment` are for editors; the strict schema must not see them. */
function withoutMetaKeys(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const meta: readonly string[] = HUB_META_KEYS;
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !meta.includes(key)));
}

function parseHub(raw: unknown, where: string): HubJson {
  const result = hubJsonSchema.safeParse(withoutMetaKeys(raw));
  if (!result.success) {
    throw new Error(`${where}: invalid hub.json\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function parseJsonBlob(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${where}: not valid JSON (${error instanceof Error ? error.message : ''})`);
  }
}

function hubFor(
  node: RepositoryNode,
  overrides: HubOverrides,
): { hub: HubJson | null; source: ProjectEntry['hub_source'] } {
  if (node.hub) {
    const raw = parseJsonBlob(node.hub.text, `${node.name}: hub.json`);
    return { hub: parseHub(raw, `${node.name}: hub.json`), source: 'repo' };
  }
  const override = overrides.get(node.name);
  if (override) {
    return { hub: parseHub(override.raw, override.file), source: 'hub' };
  }
  return { hub: null, source: null };
}

function entryFor(node: RepositoryNode, overrides: HubOverrides, fetchedAt: string): ProjectEntry {
  if (!node.defaultBranchRef) {
    throw new Error(`${node.name}: repository has no default branch (empty repo?)`);
  }
  const topics = node.repositoryTopics.nodes.map((topic) => topic.topic.name);
  const { hub, source } = hubFor(node, overrides);
  const mcpb = node.mcpb
    ? mcpbManifestSchema.parse(parseJsonBlob(node.mcpb.text, `${node.name}: mcpb/manifest.json`))
    : null;
  const server = node.server ? parseJsonBlob(node.server.text, `${node.name}: server.json`) : null;
  const candidate = {
    name: node.name,
    slug: toSlug(node.name),
    description: node.description,
    url: node.url,
    homepage: node.homepageUrl ? node.homepageUrl : null,
    stars: node.stargazerCount,
    topics,
    taxonomy: topics.filter((topic) => topic !== HUB_EXCLUDE_TOPIC),
    license: node.licenseInfo?.spdxId ?? null,
    default_branch: node.defaultBranchRef.name,
    head: {
      sha: node.defaultBranchRef.target.oid,
      committed_at: node.defaultBranchRef.target.committedDate,
    },
    release: node.latestRelease
      ? {
          tag: node.latestRelease.tagName,
          name: node.latestRelease.name,
          published_at: node.latestRelease.publishedAt,
          body: node.latestRelease.description,
          url: node.latestRelease.url,
          prerelease: node.latestRelease.isPrerelease,
        }
      : null,
    readme: node.readme?.text ?? null,
    hub,
    hub_source: source,
    server,
    mcpb,
    listed: hub?.listed ?? false,
    fetched_at: fetchedAt,
  };
  const result = projectEntrySchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`${node.name}: entry failed validation\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Turn one recorded response into validated entries, sorted by name. Pure: the fixture test
 * runs it without network. Repositories tagged `hub-exclude` are dropped before anything else.
 */
export function toEntries(
  raw: OrganizationResponse,
  overrides: HubOverrides,
  fetchedAt: string,
): ProjectEntry[] {
  const parsed = organizationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`GitHub response drifted from the query\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.data.organization.repositories.nodes
    .filter((node) => !node.repositoryTopics.nodes.some((t) => t.topic.name === HUB_EXCLUDE_TOPIC))
    .map((node) => entryFor(node, overrides, fetchedAt))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface FetchOptions {
  org: string;
  token: string | undefined;
  fetchImpl?: typeof fetch;
}

/** One GraphQL request. Any `errors` entry is a failure; partial data never reaches the site. */
export async function fetchOrganization({
  org,
  token,
  fetchImpl = fetch,
}: FetchOptions): Promise<OrganizationResponse> {
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. The GitHub loader needs a token that can read public repositories: ' +
        'in CI use github.token; locally run `GITHUB_TOKEN="$(gh auth token)" pnpm build`, or set ' +
        'HUB_GITHUB_FIXTURE to a recorded response to build offline.',
    );
  }
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'the40thieves.dev hub loader',
    },
    body: JSON.stringify({ query: ORGANIZATION_QUERY, variables: { org } }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL responded ${String(response.status)} ${response.statusText}`);
  }
  type GraphqlEnvelope = { errors?: { message: string }[] } & Partial<OrganizationResponse>;
  const json = await response.json<GraphqlEnvelope>();
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json as OrganizationResponse;
}

export interface GithubLoaderOptions extends FetchOptions {
  /** Directory of hub-side `<repo>.json` files. */
  overridesDir: string;
  /** A recorded response to build from instead of the network (tests, offline builds). */
  fixturePath?: string | undefined;
}

export function githubLoader(options: GithubLoaderOptions) {
  return {
    name: 'github-org-loader',
    schema: projectEntrySchema,
    load: async (context) => {
      const { store, logger } = context;
      const raw = options.fixturePath
        ? (JSON.parse(readFileSync(options.fixturePath, 'utf8')) as OrganizationResponse)
        : await fetchOrganization(options);
      logger.info(
        options.fixturePath
          ? `Loading repositories from fixture ${options.fixturePath}`
          : `Loading public repositories of ${options.org}`,
      );
      const entries = toEntries(
        raw,
        readHubOverrides(options.overridesDir),
        new Date().toISOString(),
      );
      store.clear();
      for (const entry of entries) {
        // fetched_at changes every build; keep it out of the digest so unchanged repos stay cached.
        const stable: Partial<ProjectEntry> = { ...entry };
        delete stable.fetched_at;
        const data = await context.parseData({ id: entry.slug, data: entry });
        store.set({ id: entry.slug, data, digest: context.generateDigest(stable) });
      }
      logger.info(
        `${String(entries.length)} repositories, ${String(entries.filter((e) => e.listed).length)} listed`,
      );
    },
  } satisfies Loader;
}
