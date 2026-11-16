import { pageRpcRequest, WEBMCP_PATH } from '@the40thieves/manifest/webmcp';

import type { ModelContextLike } from './model-context.ts';

/**
 * WebMCP page tools (P3-S4). The page registers no logic of its own: each tool is one of
 * the `/mcp` Worker's tools, described by the Worker (`/mcp/webmcp`) and executed by the Worker
 * (one POST to `/mcp`). This module is imported only after the bootstrap found a trial token,
 * declared tools and the browser API, and nothing in it throws into the page.
 */
interface PageToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDefinition(value: unknown): value is PageToolDefinition {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['description'] === 'string' &&
    isRecord(value['inputSchema'])
  );
}

/**
 * The definitions the Worker offers right now. Empty for anything but a 200 saying
 * `enabled: true`: the kill switch, an outage and a rate limit all mean "register nothing".
 */
async function fetchPageTools(
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<PageToolDefinition[]> {
  try {
    const response = await fetchImpl(WEBMCP_PATH, signal ? { signal } : undefined);
    if (response.status !== 200) return [];
    const reply: unknown = await response.json();
    if (!isRecord(reply) || reply['enabled'] !== true || !Array.isArray(reply['tools'])) return [];
    return reply['tools'].filter(isDefinition);
  } catch {
    return [];
  }
}

/** A failure the hub could explain, in the shape an MCP tool error takes. */
export interface PageToolFailure {
  isError: true;
  message: string;
}

const failure = (message: string): PageToolFailure => ({ isError: true, message });

/**
 * Call one hub tool through `/mcp` and resolve to its structured result (the text blocks when a
 * result has none). The browser serialises whatever this resolves to, and tells the agent
 * nothing about a rejection beyond "tool rejected" (WebMCP draft), so a failure the hub
 * explained (an unknown slug, bad arguments, a rate limit, an outage) resolves as
 * `{ isError: true, message }` for the agent to act on. Only a request that never got an answer
 * (offline, aborted) rejects.
 */
export async function callHubTool(
  name: string,
  input: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const { headers, body } = pageRpcRequest('tools/call', {
    name,
    arguments: isRecord(input) ? input : {},
  });
  const response = await fetchImpl('/mcp', {
    method: 'POST',
    headers,
    body,
    ...(signal ? { signal } : {}),
  });
  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    reply = undefined;
  }
  if (response.status === 429) return failure(`${name}: rate limited, retry in a minute`);
  const error = isRecord(reply) ? reply['error'] : undefined;
  if (isRecord(error) && typeof error['message'] === 'string') {
    return failure(`${name}: ${error['message']}`);
  }
  const result = isRecord(reply) ? reply['result'] : undefined;
  if (response.status !== 200 || !isRecord(result)) {
    return failure(`${name}: /mcp answered ${String(response.status)} without a result`);
  }
  const blocks: unknown[] = Array.isArray(result['content']) ? result['content'] : [];
  const text = blocks
    .filter(isRecord)
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n');
  if (result['isError'] === true) return failure(text || `${name}: the tool reported an error`);
  return isRecord(result['structuredContent']) ? result['structuredContent'] : text;
}

export interface RegisterDeps {
  modelContext: ModelContextLike;
  /** The names this page declared; nothing else is registered. */
  names: readonly string[];
  fetch: typeof fetch;
  /** Aborting it unregisters the tools (the draft has no `unregisterTool`). */
  signal?: AbortSignal;
}

/**
 * Register the declared tools the Worker defines. Resolves to the names that registered and
 * never rejects: a tool the browser refuses (a duplicate name, a schema it dislikes) is skipped
 * and the rest still register.
 */
export async function registerPageTools(deps: RegisterDeps): Promise<string[]> {
  const declared = new Set(deps.names);
  const definitions = (await fetchPageTools(deps.fetch, deps.signal)).filter((tool) =>
    declared.has(tool.name),
  );
  const registered: string[] = [];
  for (const { name, description, inputSchema } of definitions) {
    try {
      await deps.modelContext.registerTool(
        {
          name,
          description,
          inputSchema,
          // The tools only read, and what they return quotes project text: data, not instructions.
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: (input, options) => callHubTool(name, input, deps.fetch, options?.signal),
        },
        deps.signal ? { signal: deps.signal } : {},
      );
      registered.push(name);
    } catch {
      // Refused by the browser; the other tools still register.
    }
  }
  return registered;
}
