import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createDeps, handleRequest, type Env } from '../src/index.ts';
import { fakeContext, FakeRateLimiter, loadedKv } from './fake-kv.ts';

export const SITE = 'https://the40thieves.dev';

export function testEnv(): Env {
  return {
    MCP_KV: loadedKv() as unknown as KVNamespace,
    RATE_LIMITER: new FakeRateLimiter(100_000),
    SITE,
  };
}

/** A fetch that never leaves the process: every request goes straight to `handleRequest`. */
export function inProcessFetch(
  env: Env,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const deps = createDeps(env);
  return (url, init) => {
    const request = new Request(url, init);
    // The runtime sets Host; Node's Request does not, and the handler checks it.
    request.headers.set('host', new URL(SITE).hostname);
    return handleRequest(request, env, fakeContext(), deps);
  };
}

/** A v2 client connected over the legacy (2025-11-25) lane, the default for this client. */
export async function connectV2(env: Env = testEnv()): Promise<Client> {
  const client = new Client({ name: 'hub-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${SITE}/mcp`), {
    fetch: inProcessFetch(env),
  });
  await client.connect(transport);
  return client;
}

/** `callTool` narrowed to what the hub tools return. */
export interface ToolReply {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolReply> {
  return (await client.callTool({ name, arguments: args })) as ToolReply;
}

/** The first text content block, for error messages. */
export function text(reply: ToolReply): string {
  return reply.content.find((block) => block.type === 'text')?.text ?? '';
}
