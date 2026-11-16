import { pageRpcRequest, WEBMCP_PATH, WEBMCP_TOOL_NAMES } from '@the40thieves/manifest';

import { loadData } from './data.ts';
import { mcpHeadersFor } from './headers.ts';
import type { Env, HandlerDeps } from './index.ts';

/**
 * `/mcp/webmcp` (P3-S4): what a hub page reads before it registers WebMCP tools with the
 * browser. The definitions are this Worker's own `tools/list` cut down to the page subset, so a
 * page tool can never describe itself differently from the MCP tool it forwards to. One KV key
 * is the kill switch: while it exists the answer is `enabled: false` and pages register nothing.
 */

/** Present in `MCP_KV` (any value) means the page tools are off. Delete the key to turn them on. */
export const WEBMCP_KILL_SWITCH_KEY = 'webmcp-disabled';

export interface PageTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PageToolsReply {
  enabled: boolean;
  tools: PageTool[];
}

/** The policy's rules for the path (a one minute cache): only on a 200. */
const FRESHNESS_HEADERS = mcpHeadersFor(WEBMCP_PATH);

const ALLOW = 'GET, HEAD';

function json(request: Request, status: number, body: unknown, fresh = false): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (fresh) for (const [name, value] of FRESHNESS_HEADERS) headers.set(name, value);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The page subset out of a `tools/list` result, in `WEBMCP_TOOL_NAMES` order; null when any of
 * them is missing or malformed, because a partial list would look like a narrower route.
 */
export function pageToolsFrom(listResult: unknown): PageTool[] | null {
  const listed: unknown[] =
    isRecord(listResult) &&
    isRecord(listResult['result']) &&
    Array.isArray(listResult['result']['tools'])
      ? listResult['result']['tools']
      : [];
  const byName = new Map(listed.filter(isRecord).map((tool) => [tool['name'], tool]));
  const tools: PageTool[] = [];
  for (const name of WEBMCP_TOOL_NAMES) {
    const tool = byName.get(name);
    const description = tool?.['description'];
    const inputSchema = tool?.['inputSchema'];
    if (typeof description !== 'string' || !isRecord(inputSchema)) return null;
    tools.push({ name, description, inputSchema });
  }
  return tools;
}

/** The response for a request to `WEBMCP_PATH`. A `DataError` from the first read propagates. */
export async function pageToolsResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: HandlerDeps,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const refusal = json(request, 405, { error: 'method not allowed' });
    refusal.headers.set('allow', ALLOW);
    return refusal;
  }
  if ((await env.MCP_KV.get(WEBMCP_KILL_SWITCH_KEY)) !== null) {
    const off: PageToolsReply = { enabled: false, tools: [] };
    return json(request, 200, off, true);
  }
  // Fail as "data not loaded" before asking the handler, which would answer a generic error.
  await loadData(env.MCP_KV, deps.now());
  const { headers, body } = pageRpcRequest('tools/list', {});
  const inner = new Request(new URL('/mcp', request.url), { method: 'POST', headers, body });
  // The handler checks Host against the site; carry the one this request arrived with.
  const host = request.headers.get('host');
  if (host !== null) inner.headers.set('host', host);
  const listed = await deps.handler(inner, env, ctx);
  const tools = listed.status === 200 ? pageToolsFrom(await listed.json()) : null;
  if (tools === null) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        route: 'webmcp',
        error: `tools/list answered ${String(listed.status)} without the page subset`,
      }),
    );
    return json(request, 503, { error: 'page tools unavailable' });
  }
  const on: PageToolsReply = { enabled: true, tools };
  return json(request, 200, on, true);
}
