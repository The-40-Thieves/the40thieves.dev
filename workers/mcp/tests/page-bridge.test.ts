import { pageRpcRequest } from '@the40thieves/manifest/webmcp';
import { beforeEach, expect, test } from 'vitest';

import { resetDataCache } from '../src/data.ts';
import { inProcessFetch, SITE, testEnv } from './client.ts';

/**
 * The wire contract the hub's WebMCP page tools rely on (P3-S4): a script on the site calls
 * a tool with one same-origin POST built by `pageRpcRequest`, no `initialize` first and no
 * session, and reads one JSON body back. The SDK owns this behaviour, so an upgrade that changes
 * it fails here before it fails in a browser.
 */
function send(method: 'tools/list' | 'tools/call', params: Record<string, unknown>) {
  const { headers, body } = pageRpcRequest(method, params);
  // A browser adds Origin to a same-origin POST; the handler accepts only the site's.
  return inProcessFetch(testEnv())(`${SITE}/mcp`, {
    method: 'POST',
    headers: { ...headers, origin: SITE },
    body,
  });
}

interface RpcReply {
  result?: {
    tools?: { name: string; inputSchema?: Record<string, unknown> }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

beforeEach(() => {
  resetDataCache();
});

test('a page tools/call answers one JSON body with the tool result', async () => {
  const response = await send('tools/call', {
    name: 'search_projects',
    arguments: { query: 'codecalc' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const reply: RpcReply = await response.json();
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).not.toBe(true);
  const text = reply.result?.content?.find((block) => block.type === 'text')?.text ?? '';
  expect(JSON.parse(text)).toHaveProperty('results');
});

test('a page tools/call for an unknown slug is an isError result, not a transport error', async () => {
  const response = await send('tools/call', {
    name: 'get_install',
    arguments: { slug: 'no-such-project', client: 'shell' },
  });
  expect(response.status).toBe(200);
  const reply: RpcReply = await response.json();
  expect(reply.result?.isError).toBe(true);
  expect(reply.result?.content?.[0]?.text).toContain('no-such-project');
});

test('a page tools/list answers one JSON body with a JSON Schema per tool', async () => {
  const response = await send('tools/list', {});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const reply: RpcReply = await response.json();
  const search = reply.result?.tools?.find((tool) => tool.name === 'search_projects');
  expect(search?.inputSchema?.['type']).toBe('object');
});
