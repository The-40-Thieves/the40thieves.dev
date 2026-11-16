import { WEBMCP_PATH } from '@the40thieves/manifest';
import { createMcpHandler } from 'agents/mcp/server';

import { CARD_CORS_HEADERS, SERVER_CARD_PATH, serverCardResponse } from './card.ts';
import { DataError, loadData } from './data.ts';
import { applyMcpHeaders } from './headers.ts';
import { clientKey, type Limiter, RATE_LIMIT_PERIOD_SECONDS } from './ratelimit.ts';
import { createServer } from './server.ts';
import { pageToolsResponse } from './webmcp.ts';

/**
 * `mcp` (P3-S1): the Worker on the40thieves.dev/mcp, the public read-only MCP server.
 *
 * It has no secrets and sits behind no Access: everything it serves is the manifest and the
 * Markdown twins in another shape. The hub build emits both documents, the deploy uploads them
 * to KV, and this file only wires bindings to the handler. `/mcp/server-card` (P3-S3) is
 * the static Server Card clients read before they connect; `/mcp/webmcp` (P3-S4) is what
 * a hub page reads before it registers WebMCP tools.
 */
export interface Env {
  MCP_KV: KVNamespace;
  RATE_LIMITER: RateLimit;
  /** The site origin, the one browser Origin the handler accepts. */
  SITE?: string | undefined;
  /** The hostname the Worker answers on when it differs from the site's. */
  MCP_HOSTNAME?: string | undefined;
}

export interface HandlerDeps {
  /** The MCP handler for `/mcp` itself; `createDeps` builds the real one. */
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  now: () => number;
}

// Not exported: workerd treats every named export of the entry module as a handler.
const DEFAULT_SITE = 'https://the40thieves.dev';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

/** The real MCP handler: a fresh server per request over the KV documents, Origin-checked. */
export function createDeps(env: Env): HandlerDeps {
  const site = new URL(env.SITE ?? DEFAULT_SITE);
  const handler = createMcpHandler(async () => createServer(await loadData(env.MCP_KV)), {
    route: '/mcp',
    // Agents call from processes, not pages: no CORS, and a browser Origin must be the site.
    corsOptions: false,
    allowedHostnames: [env.MCP_HOSTNAME ?? site.hostname],
    allowedOriginHostnames: [site.hostname],
    legacy: 'stateless',
    // One JSON body per exchange: the tools emit no mid-call notifications, so nothing streams.
    responseMode: 'json',
    onerror: (error) => {
      log({ handler: 'mcp', error: String(error) });
    },
  });
  return { handler: (request, bindings, ctx) => handler(request, bindings, ctx), now: Date.now };
}

async function healthz(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
  }
  try {
    const { manifest } = await loadData(env.MCP_KV, deps.now());
    return json(200, { ok: true, generated_at: manifest.generated_at });
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    log({ route: 'healthz', error: error.message });
    return json(503, { ok: false, error: 'data not loaded' });
  }
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: HandlerDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/mcp/healthz') return healthz(request, env, deps);
  const isCard = pathname === SERVER_CARD_PATH;
  const isPageTools = pathname === WEBMCP_PATH;
  if (pathname !== '/mcp' && !isCard && !isPageTools) return json(404, { error: 'not found' });
  // One budget per IP for the endpoint and its card; upstream asks for a limit on card hosts.
  const limiter: Limiter = env.RATE_LIMITER;
  const { success } = await limiter.limit({ key: clientKey(request) });
  if (!success) {
    return json(
      429,
      { error: 'rate limited' },
      {
        'retry-after': String(RATE_LIMIT_PERIOD_SECONDS),
        // A browser client must be able to read the refusal too.
        ...(isCard ? Object.fromEntries(CARD_CORS_HEADERS) : {}),
      },
    );
  }
  if (isCard) return serverCardResponse(request, env.SITE ?? DEFAULT_SITE);
  try {
    if (isPageTools) return await pageToolsResponse(request, env, ctx, deps);
    return await deps.handler(request, env, ctx);
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    log({ route: isPageTools ? 'webmcp' : 'mcp', error: error.message });
    return json(503, { error: 'data not loaded' });
  }
}

/** Every response, whatever produced it, leaves with the `mcp` policy headers. */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: HandlerDeps,
): Promise<Response> {
  return applyMcpHeaders(await route(request, env, ctx, deps));
}

/** One handler per isolate: bindings do not change for its lifetime. */
let deps: HandlerDeps | undefined;

export default {
  fetch(request, env, ctx): Promise<Response> {
    deps ??= createDeps(env);
    return handleRequest(request, env, ctx, deps);
  },
} satisfies ExportedHandler<Env>;
