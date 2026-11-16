import {
  SOURCE_ROUTES,
  sourcesFileSchema,
  type SourceEntry,
  type SourceRoute,
  type SourcesFile,
} from '@the40thieves/schemas';

import raw from '../../../../data/sources.json' with { type: 'json' };

/**
 * `data/sources.json` (P4-S1), validated once at build time. The page, its twin and the
 * JSON route all read this one value, so they can never disagree with each other or the schema.
 */
export const sourcesFile: SourcesFile = sourcesFileSchema.parse(raw);

/** One line per route, in the order the schema lists them, for the page and the twin. */
export const ROUTE_NOTES: Record<SourceRoute, string> = {
  'browser-direct':
    'the browser calls the source itself; CORS allows this origin, and a key, when the source wants one, is the visitor’s and never leaves the browser',
  'visitor-key-relay':
    'the browser calls relay.the40thieves.dev, which forwards the request, and the visitor’s key when there is one, to a host that does not allow this origin',
  'quota-relay':
    'the relay holds an operator key with a daily cap for a keyed source that does not allow this origin',
  'mcp-only': 'only alexandria-mcp itself serves the source: remote MCP servers and scraped sites',
};

/** `152 sources: 70 browser-direct, 67 visitor-key-relay, 3 quota-relay, 12 mcp-only.` */
export function routeSummary(file: SourcesFile): string {
  const parts = SOURCE_ROUTES.map((route) => `${String(file.routes[route])} ${route}`);
  return `${String(file.sources.length)} sources: ${parts.join(', ')}.`;
}

/** Sources grouped by cluster, clusters and sources both in name order. */
export function byCluster(file: SourcesFile): Array<{ cluster: string; sources: SourceEntry[] }> {
  const groups = new Map<string, SourceEntry[]>();
  for (const source of file.sources) {
    const list = groups.get(source.cluster) ?? [];
    list.push(source);
    groups.set(source.cluster, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([cluster, sources]) => ({ cluster, sources }));
}

/** `GUARDIAN_API_KEY (450/day)`, `CORE_API_KEY`, or `none`. */
export function keyText(source: SourceEntry): string {
  if (!source.key) return 'none';
  return source.key.daily_cap === null
    ? source.key.env
    : `${source.key.env} (${String(source.key.daily_cap)}/day)`;
}

export function upstreamTreeUrl(file: SourcesFile): string {
  return `https://github.com/${file.upstream.repo}/tree/${file.upstream.commit}`;
}
