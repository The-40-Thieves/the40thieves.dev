import {
  SOURCE_ROUTES,
  SOURCES_SCHEMA_ID,
  sourcesFileSchema,
  type CorsVerdict,
  type IngestPolicy,
  type SourceEntry,
  type SourceKind,
  type SourceRoute,
  type SourcesFile,
} from '@the40thieves/schemas';

/**
 * The classification core of the alexandria source probe (P4-S1). `scripts/probe-sources.ts`
 * loads alexandria-mcp's registry and records what each adapter's search request looked like from
 * the browser's point of view; the functions here turn those facts into `data/sources.json`
 * entries with one route each. Nothing in this file touches the network, so every rule is pinned
 * by `tests/probe-sources.test.ts`.
 */

/** The origin the recorder sends; the CORS verdicts hold for it alone. */
export const PROBE_ORIGIN = 'https://the40thieves.dev';

/** The value every declared key env gets while the adapters run. Not a credential. */
export const KEY_PLACEHOLDER = 'the40thieves-probe';

export const UPSTREAM_REPO = 'The-40-Thieves/alexandria-mcp';

/** The subset of alexandria-mcp's `SourceMeta` (src/sources/registry.ts) the probe reads. */
export interface UpstreamSource {
  name: string;
  description: string;
  kind: SourceKind;
  cluster: string;
  freshness: 'realtime' | 'daily' | 'static';
  homepage?: string;
  auth?: {
    type: 'none' | 'query' | 'header' | 'bearer';
    env?: string;
    param?: string;
    header?: string;
  };
  pacing?: { minIntervalMs?: number; dailyCap?: number };
  optionalEnv?: string[];
  ingestPolicy?: IngestPolicy;
  hidden?: boolean;
}

/** One request the recorder saw for a source, reduced to what CORS classification needs. */
export interface Capture {
  /** The request's host; never the full URL, which may carry a key parameter. */
  host: string;
  /**
   * Request header names, lowercase, as the adapter sent them (plus the probe's own Origin).
   * `content-type` appears only when its value was not CORS-safelisted, since that alone makes the
   * request non-simple; a safelisted one (form or plain text) is left out.
   */
  requestHeaders: string[];
  status: number;
  /** The response's Access-Control-Allow-Origin, or null when absent. */
  acao: string | null;
  /** The OPTIONS preflight the recorder sent when a non-simple header was present, or null. */
  preflight: { acao: string | null; allowHeaders: string | null } | null;
}

/** Kinds the browser can never reach directly or through the relay; their route is fixed. */
const MCP_ONLY_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(['mcp', 'scrape']);

/**
 * CORS-safelisted request headers (Fetch standard) plus the ones the browser or the recorder sets
 * itself. Anything else makes the request non-simple, so a preflight must allow it. `content-type`
 * is safelisted by value, not by name: see SIMPLE_CONTENT_TYPES.
 */
const SIMPLE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'origin',
  'user-agent',
  'range',
]);

/** The three content-type essences a browser sends without a preflight. */
const SIMPLE_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);

/**
 * Whether a request header needs no preflight. For `content-type` the answer depends on the value;
 * without one (a capture lists only the names it recorded as non-simple) it is non-simple.
 */
export function isSimpleRequestHeader(name: string, value?: string | null): boolean {
  const lower = name.toLowerCase();
  if (lower === 'content-type') {
    if (value === undefined || value === null) return false;
    const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
    return SIMPLE_CONTENT_TYPES.has(essence);
  }
  return SIMPLE_HEADERS.has(lower);
}

function originAllowed(acao: string | null): boolean {
  return acao === '*' || acao === PROBE_ORIGIN;
}

function preflightAllows(capture: Capture, nonSimple: string[]): boolean {
  const preflight = capture.preflight;
  if (!preflight || !originAllowed(preflight.acao)) return false;
  const allowed = (preflight.allowHeaders ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
  // The wildcard covers every header but Authorization, which has to be listed by name (Fetch).
  if (allowed.includes('*')) {
    return !nonSimple.includes('authorization') || allowed.includes('authorization');
  }
  return nonSimple.every((header) => allowed.includes(header));
}

/**
 * `open` only when every request the adapter made would succeed from a page on PROBE_ORIGIN:
 * the response allows the origin and, where a non-simple header was sent, the preflight allows
 * the origin and that header. `unknown` when nothing was captured.
 */
export function corsVerdict(captures: Capture[]): CorsVerdict {
  if (captures.length === 0) return 'unknown';
  for (const capture of captures) {
    if (!originAllowed(capture.acao)) return 'closed';
    const nonSimple = capture.requestHeaders
      .map((header) => header.toLowerCase())
      .filter((header) => !isSimpleRequestHeader(header));
    if (nonSimple.length > 0 && !preflightAllows(capture, nonSimple)) return 'closed';
  }
  return 'open';
}

export function keyFor(source: UpstreamSource): SourceEntry['key'] {
  const auth = source.auth;
  if (!auth || auth.type === 'none' || !auth.env) return null;
  return { env: auth.env, type: auth.type, daily_cap: source.pacing?.dailyCap ?? null };
}

/** The one route a source gets. Order matters: kind first, then what the browser can reach. */
export function routeFor(source: UpstreamSource, cors: CorsVerdict): SourceRoute {
  if (MCP_ONLY_KINDS.has(source.kind)) return 'mcp-only';
  if (cors === 'open') return 'browser-direct';
  const key = keyFor(source);
  if (key && key.daily_cap !== null) return 'quota-relay';
  return 'visitor-key-relay';
}

/**
 * The environment the adapters run under: a placeholder for every declared key env so keyed
 * adapters build and send their request, and every optional env cleared so a token on the
 * machine (GITHUB_TOKEN, a contact email) never changes what the recorder sees.
 */
export function probeEnv(
  sources: UpstreamSource[],
  placeholder: string = KEY_PLACEHOLDER,
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset = new Set<string>();
  for (const source of sources) {
    if (source.auth?.env && source.auth.type !== 'none') set[source.auth.env] = placeholder;
    for (const name of source.optionalEnv ?? []) unset.add(name);
  }
  for (const name of Object.keys(set)) unset.delete(name);
  return { set, unset: [...unset].sort((a, b) => a.localeCompare(b, 'en')) };
}

export function entryFor(
  source: UpstreamSource,
  captures: Capture[],
  probe: SourceEntry['probe'],
): SourceEntry {
  const cors = corsVerdict(captures);
  return {
    name: source.name,
    kind: source.kind,
    cluster: source.cluster,
    freshness: source.freshness,
    description: source.description.replace(/\s+/g, ' ').trim(),
    key: keyFor(source),
    cors,
    hosts: [...new Set(captures.map((capture) => capture.host))].sort((a, b) =>
      a.localeCompare(b, 'en'),
    ),
    terms: { url: source.homepage ?? '', ingest: source.ingestPolicy ?? 'allowed' },
    route: routeFor(source, cors),
    probe,
  };
}

/** Sorted, counted and validated through the schema, so a bad build throws instead of writing. */
export function buildSourcesFile(
  entries: SourceEntry[],
  upstream: { commit: string },
): SourcesFile {
  const sources = [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const routes = Object.fromEntries(
    SOURCE_ROUTES.map((route) => [route, sources.filter((s) => s.route === route).length]),
  ) as Record<SourceRoute, number>;
  return sourcesFileSchema.parse({
    $schema: SOURCES_SCHEMA_ID,
    version: 1,
    origin: PROBE_ORIGIN,
    upstream: { repo: UPSTREAM_REPO, commit: upstream.commit, sources: sources.length },
    routes,
    sources,
  });
}

/** The file as committed: two-space JSON with a trailing newline, no timestamps anywhere. */
export function renderSourcesFile(file: SourcesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const DIFFED_FIELDS = [
  'kind',
  'cluster',
  'key',
  'cors',
  'hosts',
  'route',
  'probe.status',
  'probe.detail',
] as const;

function fieldText(entry: SourceEntry, field: (typeof DIFFED_FIELDS)[number]): string {
  switch (field) {
    case 'key':
      return entry.key ? `${entry.key.env}/${entry.key.type}` : 'none';
    case 'hosts':
      return entry.hosts.length > 0 ? entry.hosts.join(' ') : '(none)';
    case 'probe.status':
      return entry.probe.status;
    case 'probe.detail':
      return entry.probe.detail ?? 'null';
    default:
      return entry[field];
  }
}

/**
 * What changed between two files, one line per source (`+ name: added (route)`,
 * `- name: removed (route)`, `~ name: field old -> new, ...`), plus the upstream commit when it
 * moved. `--check` prints this, a write over an existing file logs it, and the weekly workflow
 * copies those lines into its PR body; a positional line diff of a 150-entry JSON file says
 * nothing once one entry shifts.
 */
export function diffSourcesFiles(before: SourcesFile | null, after: SourcesFile): string[] {
  const lines: string[] = [];
  if (before && before.upstream.commit !== after.upstream.commit) {
    lines.push(`~ upstream.commit ${before.upstream.commit} -> ${after.upstream.commit}`);
  }
  const old = new Map((before?.sources ?? []).map((entry) => [entry.name, entry]));
  const current = new Map(after.sources.map((entry) => [entry.name, entry]));
  const names = [...new Set([...old.keys(), ...current.keys()])].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  for (const name of names) {
    const was = old.get(name);
    const is = current.get(name);
    if (!was && is) lines.push(`+ ${name}: added (${is.route})`);
    else if (was && !is) lines.push(`- ${name}: removed (${was.route})`);
    else if (was && is) {
      const changes = DIFFED_FIELDS.filter(
        (field) => fieldText(was, field) !== fieldText(is, field),
      ).map((field) => `${field} ${fieldText(was, field)} -> ${fieldText(is, field)}`);
      if (changes.length > 0) lines.push(`~ ${name}: ${changes.join(', ')}`);
    }
  }
  return lines;
}
