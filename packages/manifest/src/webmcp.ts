/**
 * WebMCP page tools (P3-S4): which of the hub's `/mcp` tools a page offers to an in-browser
 * agent, and the one request shape a page uses to reach the Worker. The layout, the page script,
 * the Worker and the contract gate all read this file, and it imports nothing, so the page
 * bundle that includes it stays small.
 */

/** Offered on every hub page: find a project, then get its install line. */
export const WEBMCP_HUB_TOOLS: readonly string[] = ['search_projects', 'get_install'];

/** Added on the pages `read_doc` can read: project pages and the changelog. */
export const WEBMCP_DOC_TOOLS: readonly string[] = ['read_doc'];

/** Every tool a page may register, in registration order. A subset of the manifest's tools. */
export const WEBMCP_TOOL_NAMES: readonly string[] = [...WEBMCP_HUB_TOOLS, ...WEBMCP_DOC_TOOLS];

/** `<meta name>` carrying a page's tool names, space separated. */
export const WEBMCP_TOOLS_META = 'webmcp-tools';

/** The Worker path that answers the page tool definitions and the kill switch. */
export const WEBMCP_PATH = '/mcp/webmcp';

const TOP_LEVEL_PAGE = /^\/[a-z0-9-]+\/$/;

/**
 * The tools the page at `page` (a site path with a trailing slash) offers. The 404 page and
 * anything that is not a hub page (the docs sites are other Workers) offer none.
 */
export function webmcpToolsFor(page: string): readonly string[] {
  if (page === '/') return WEBMCP_HUB_TOOLS;
  if (page === '/404/' || !TOP_LEVEL_PAGE.test(page)) return [];
  return WEBMCP_TOOL_NAMES;
}

const META_TAG = /<meta\s[^>]*>/gi;

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;
}

/** The tool names a built HTML page declares in its tools meta; none when it has no such tag. */
export function pageDeclaredTools(html: string): string[] {
  for (const tag of html.match(META_TAG) ?? []) {
    if (attribute(tag, 'name') !== WEBMCP_TOOLS_META) continue;
    return (attribute(tag, 'content') ?? '').split(/\s+/).filter((name) => name !== '');
  }
  return [];
}

/** The protocol revision a page speaks to `/mcp`: stateless, one JSON body per request. */
export const PAGE_PROTOCOL_VERSION = '2026-07-28';

export interface PageRpcRequest {
  headers: Record<string, string>;
  body: string;
}

/**
 * One stateless JSON-RPC request to `/mcp` as a page sends it: no `initialize`, no session. The
 * 2026-07-28 revision wants the method (and for a call the tool name) repeated in headers and
 * the protocol version and client capabilities in `params._meta`; with those the Worker answers
 * one `application/json` body. `workers/mcp/tests/page-bridge.test.ts` pins that against the
 * real handler.
 */
export function pageRpcRequest(
  method: 'tools/list' | 'tools/call',
  params: Record<string, unknown>,
): PageRpcRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PAGE_PROTOCOL_VERSION,
    'mcp-method': method,
  };
  const name = params['name'];
  if (method === 'tools/call' && typeof name === 'string') headers['mcp-name'] = name;
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PAGE_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
}
