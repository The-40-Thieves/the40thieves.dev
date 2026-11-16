import { mcpHeadersFor } from './headers.ts';
import { SERVER_VERSION } from './server.ts';

/**
 * The MCP Server Card (SEP-2127, P3-S3): a static document a client reads before it
 * connects. It carries identity, the transport endpoint and the protocol versions, never the
 * tools; `/.well-known/ai-catalog.json` on the hub points at it. It is built from constants and
 * the site origin, so it answers while the KV documents are still loading.
 */
export const SERVER_CARD_PATH = '/mcp/server-card';
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const SERVER_CARD_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

/** `namespace/name`, the form the schema requires; the name P3-S6 registers. */
export const SERVER_CARD_NAME = 'io.github.The-40-Thieves/the40thieves-dev';

/** At most 100 characters (schema). */
export const SERVER_CARD_DESCRIPTION =
  'Read-only tools over The 40 Thieves project hub: search, compare, installs, releases, docs.';

/**
 * What `server/discover` reports as `supportedVersions`; the conformance test compares the two.
 * The legacy 2025-11-25 handshake still answers but is not advertised here.
 */
export const CARD_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

export interface ServerCardRemote {
  type: 'streamable-http';
  url: string;
  supportedProtocolVersions: string[];
}

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  websiteUrl: string;
  remotes: ServerCardRemote[];
}

/** The card for a site origin (no trailing slash), e.g. `https://the40thieves.dev`. */
export function buildServerCard(site: string): ServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: SERVER_CARD_NAME,
    version: SERVER_VERSION,
    description: SERVER_CARD_DESCRIPTION,
    websiteUrl: `${site}/`,
    remotes: [
      {
        type: 'streamable-http',
        url: `${site}/mcp`,
        supportedProtocolVersions: [...CARD_PROTOCOL_VERSIONS],
      },
    ],
  };
}

const CARD_RULES = mcpHeadersFor(SERVER_CARD_PATH);

/** CORS for browser clients: on every response from the card path, errors included. */
export const CARD_CORS_HEADERS: ReadonlyArray<readonly [string, string]> = CARD_RULES.filter(
  ([name]) => name.toLowerCase().startsWith('access-control-'),
);

/** Everything else the policy scopes to the path (caching): only on a 200 or a 304. */
const CARD_FRESHNESS_HEADERS = CARD_RULES.filter(
  ([name]) => !name.toLowerCase().startsWith('access-control-'),
);

const ALLOW = 'GET, HEAD, OPTIONS';

/**
 * True when an `If-None-Match` value names `etag`: weak comparison (a `W/` prefix is ignored, as
 * an intermediary may weaken the validator), any member of a list, or `*`.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  return ifNoneMatch.split(',').some((member) => {
    const candidate = member.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === etag;
  });
}

/** A strong validator derived from the body, so it changes exactly when the card does. */
async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `"${hex.join('').slice(0, 32)}"`;
}

/** The response for a request to `SERVER_CARD_PATH`. */
export async function serverCardResponse(request: Request, site: string): Promise<Response> {
  const headers = new Headers(CARD_CORS_HEADERS.map(([name, value]) => [name, value]));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    headers.set('allow', ALLOW);
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
  }
  const body = JSON.stringify(buildServerCard(site));
  const etag = await etagFor(body);
  headers.set('etag', etag);
  for (const [name, value] of CARD_FRESHNESS_HEADERS) headers.set(name, value);
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-type', SERVER_CARD_MEDIA_TYPE);
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}
