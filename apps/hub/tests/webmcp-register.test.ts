import { pageRpcRequest } from '@the40thieves/manifest/webmcp';
import { expect, test } from 'vitest';

import { gatedToolNames } from '../src/lib/webmcp/gate.ts';
import {
  findModelContext,
  type ModelContextLike,
  type PageToolRegistration,
} from '../src/lib/webmcp/model-context.ts';
import { callHubTool, registerPageTools } from '../src/lib/webmcp/register.ts';

// P3-S4: the page module, driven with fakes. It must register only what the page declares
// and the Worker defines, forward every call to /mcp, and never throw into the page.

/** A document that answers `meta[attr="value"]` selectors from a list of attribute maps. */
function fakeDocument(metas: Partial<Record<string, string>>[]) {
  return {
    querySelector(selector: string) {
      const match = /^meta\[([a-z-]+)="([^"]+)"( i)?\]$/.exec(selector);
      if (!match) throw new Error(`unexpected selector ${selector}`);
      const [, attribute = '', value = ''] = match;
      const meta = metas.find((entry) => entry[attribute]?.toLowerCase() === value.toLowerCase());
      return meta ? { getAttribute: (name: string) => meta[name] ?? null } : null;
    },
  };
}

const TOKEN_META = { 'http-equiv': 'origin-trial', content: 'abc' };
const toolsMeta = (content: string) => ({ name: 'webmcp-tools', content });

test('a page offers its declared tools only when a trial token meta is present', () => {
  expect(
    gatedToolNames(fakeDocument([TOKEN_META, toolsMeta('search_projects get_install')])),
  ).toEqual(['search_projects', 'get_install']);
  expect(gatedToolNames(fakeDocument([toolsMeta('search_projects')]))).toEqual([]);
  expect(gatedToolNames(fakeDocument([TOKEN_META]))).toEqual([]);
  expect(gatedToolNames(fakeDocument([TOKEN_META, toolsMeta('  ')]))).toEqual([]);
  expect(
    gatedToolNames(fakeDocument([{ 'http-equiv': 'Origin-Trial', content: 'x' }, toolsMeta('a')])),
  ).toEqual(['a']);
});

test('findModelContext prefers the document, falls back to the navigator, else null', () => {
  const onDocument = { registerTool: () => undefined };
  const onNavigator = { registerTool: () => undefined };
  expect(findModelContext({ modelContext: onDocument }, { modelContext: onNavigator })).toBe(
    onDocument,
  );
  expect(findModelContext({}, { modelContext: onNavigator })).toBe(onNavigator);
  expect(findModelContext({}, {})).toBeNull();
  expect(findModelContext({ modelContext: {} }, { modelContext: null })).toBeNull();
  expect(findModelContext({ modelContext: { registerTool: 'no' } }, {})).toBeNull();
  const throwing = Object.defineProperty({}, 'modelContext', {
    get() {
      throw new Error('blocked by permissions policy');
    },
  });
  expect(findModelContext(throwing, { modelContext: onNavigator })).toBe(onNavigator);
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const DEFINITIONS = [
  { name: 'search_projects', description: 'Search.', inputSchema: { type: 'object' } },
  { name: 'get_install', description: 'Install.', inputSchema: { type: 'object' } },
  { name: 'read_doc', description: 'Read.', inputSchema: { type: 'object' } },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers `/mcp/webmcp` with `tools` and `/mcp` with `call`. */
function fakeFetch(tools: Response | (() => Response) | Error, call?: Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const answer = url === '/mcp/webmcp' ? tools : call;
    if (answer === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === 'function' ? answer() : answer.clone());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fakeModelContext(behaviour: (tool: PageToolRegistration) => unknown = () => undefined) {
  const registered: { tool: PageToolRegistration; options: unknown }[] = [];
  const modelContext: ModelContextLike = {
    registerTool(tool, options) {
      const outcome = behaviour(tool);
      registered.push({ tool, options });
      return outcome;
    },
  };
  return { modelContext, registered };
}

const enabled = () => jsonResponse({ enabled: true, tools: DEFINITIONS });

test('registers the declared tools the Worker defines, read-only and untrusted', async () => {
  const { fetchImpl, calls } = fakeFetch(enabled());
  const { modelContext, registered } = fakeModelContext();
  const names = await registerPageTools({
    modelContext,
    names: ['search_projects', 'get_install'],
    fetch: fetchImpl,
  });
  expect(names).toEqual(['search_projects', 'get_install']);
  expect(calls.map((call) => call.url)).toEqual(['/mcp/webmcp']);
  expect(registered.map((entry) => entry.tool.name)).toEqual(['search_projects', 'get_install']);
  expect(registered[0]?.tool.description).toBe('Search.');
  expect(registered[0]?.tool.inputSchema).toEqual({ type: 'object' });
  expect(registered[0]?.tool.annotations).toEqual({
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  expect(typeof registered[0]?.tool.execute).toBe('function');
});

test('the abort signal is handed to registerTool so aborting unregisters', async () => {
  const { fetchImpl } = fakeFetch(enabled());
  const { modelContext, registered } = fakeModelContext();
  const controller = new AbortController();
  await registerPageTools({
    modelContext,
    names: ['read_doc'],
    fetch: fetchImpl,
    signal: controller.signal,
  });
  expect(registered[0]?.options).toEqual({ signal: controller.signal });
});

test('a tool the page did not declare is never registered, whatever the Worker lists', async () => {
  const extra = { name: 'compare_projects', description: 'x', inputSchema: { type: 'object' } };
  const { fetchImpl } = fakeFetch(jsonResponse({ enabled: true, tools: [...DEFINITIONS, extra] }));
  const { modelContext, registered } = fakeModelContext();
  expect(
    await registerPageTools({ modelContext, names: ['read_doc', 'made_up'], fetch: fetchImpl }),
  ).toEqual(['read_doc']);
  expect(registered).toHaveLength(1);
});

test('anything but a 200 with enabled true registers nothing and does not throw', async () => {
  const answers: (Response | Error)[] = [
    jsonResponse({ enabled: false, tools: [] }),
    jsonResponse({ enabled: false, tools: DEFINITIONS }),
    jsonResponse({ enabled: 'yes', tools: DEFINITIONS }),
    jsonResponse({ enabled: true }),
    jsonResponse({ enabled: true, tools: 'nope' }),
    jsonResponse({ error: 'not found' }, 404),
    jsonResponse({ error: 'rate limited' }, 429),
    jsonResponse({ error: 'data not loaded' }, 503),
    jsonResponse('<html>oops</html>'),
    jsonResponse('null'),
    new TypeError('network down'),
  ];
  for (const answer of answers) {
    const { fetchImpl } = fakeFetch(answer);
    const { modelContext, registered } = fakeModelContext();
    const names = await registerPageTools({ modelContext, names: ['read_doc'], fetch: fetchImpl });
    expect(names).toEqual([]);
    expect(registered).toEqual([]);
  }
});

test('malformed definitions are skipped and the good ones still register', async () => {
  const tools = [
    null,
    { name: 'search_projects', description: 7, inputSchema: { type: 'object' } },
    { name: 'get_install', description: 'Install.', inputSchema: 'x' },
    { name: 'read_doc', description: 'Read.', inputSchema: { type: 'object' } },
  ];
  const { fetchImpl } = fakeFetch(jsonResponse({ enabled: true, tools }));
  const { modelContext } = fakeModelContext();
  expect(
    await registerPageTools({
      modelContext,
      names: ['search_projects', 'get_install', 'read_doc'],
      fetch: fetchImpl,
    }),
  ).toEqual(['read_doc']);
});

test('a registerTool that throws or rejects for one tool does not stop the others', async () => {
  for (const failure of [
    () => {
      throw new Error('duplicate tool');
    },
    () => Promise.reject(new Error('invalid schema')),
  ]) {
    const { fetchImpl } = fakeFetch(enabled());
    const { modelContext } = fakeModelContext((tool) =>
      tool.name === 'search_projects' ? failure() : Promise.resolve(),
    );
    expect(
      await registerPageTools({
        modelContext,
        names: ['search_projects', 'get_install', 'read_doc'],
        fetch: fetchImpl,
      }),
    ).toEqual(['get_install', 'read_doc']);
  }
});

const textResult = (text: string, isError = false) =>
  jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError } });

/** What the Worker answers: the structured result, mirrored as JSON text for text-only clients. */
const structuredResult = (structuredContent: Record<string, unknown>) =>
  jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  });

test('execute posts the page request to /mcp and resolves to the structured result', async () => {
  const { fetchImpl, calls } = fakeFetch(enabled(), structuredResult({ results: [] }));
  const { modelContext, registered } = fakeModelContext();
  await registerPageTools({ modelContext, names: ['search_projects'], fetch: fetchImpl });
  const controller = new AbortController();
  const output = await registered[0]?.tool.execute(
    { query: 'calc' },
    { signal: controller.signal },
  );
  // The browser serialises whatever execute resolves to (WebMCP draft), so the page hands over
  // the object, not the Worker's JSON text: a string would reach the agent encoded twice.
  expect(output).toEqual({ results: [] });
  const expected = pageRpcRequest('tools/call', {
    name: 'search_projects',
    arguments: { query: 'calc' },
  });
  expect(calls[1]?.url).toBe('/mcp');
  expect(calls[1]?.init?.method).toBe('POST');
  expect(calls[1]?.init?.headers).toEqual(expected.headers);
  expect(calls[1]?.init?.body).toBe(expected.body);
  expect(calls[1]?.init?.signal).toBe(controller.signal);
});

test('callHubTool sends an empty object when the agent passes no arguments', async () => {
  const { fetchImpl, calls } = fakeFetch(enabled(), textResult('ok'));
  for (const input of [undefined, null, 'text', ['a']]) {
    await callHubTool('read_doc', input, fetchImpl);
  }
  for (const call of calls) {
    const sent = call.init?.body;
    const body = JSON.parse(typeof sent === 'string' ? sent : 'null') as {
      params: { arguments: unknown };
    };
    expect(body.params.arguments).toEqual({});
  }
});

test('callHubTool falls back to the text blocks when a result has no structured content', async () => {
  const reply = jsonResponse({
    result: {
      content: [
        { type: 'text', text: 'one' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'two' },
      ],
    },
  });
  expect(await callHubTool('read_doc', {}, fakeFetch(enabled(), reply).fetchImpl)).toBe('one\ntwo');
});

// The browser tells the agent nothing about a rejected execute beyond "tool rejected" (WebMCP
// draft), so every failure the hub can explain resolves as data the agent can act on.
test('callHubTool resolves a failure the hub explained as { isError, message }', async () => {
  const cases: [Response, RegExp][] = [
    [textResult('unknown project nope', true), /unknown project nope/],
    [jsonResponse({ result: { content: [], isError: true } }), /tool reported an error/],
    [
      // An error result never passes its structured half off as the answer.
      jsonResponse({
        result: {
          content: [{ type: 'text', text: 'bad slug' }],
          structuredContent: { results: [] },
          isError: true,
        },
      }),
      /bad slug/,
    ],
    [
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }),
      /Invalid params/,
    ],
    [jsonResponse({ error: 'rate limited' }, 429), /rate limited, retry in a minute/],
    [jsonResponse({ error: 'data not loaded' }, 503), /503/],
    [jsonResponse('<html>'), /200/],
    [jsonResponse({ result: 'nope' }), /200/],
  ];
  for (const [answer, message] of cases) {
    const { fetchImpl } = fakeFetch(enabled(), answer);
    const output = await callHubTool('get_install', { slug: 'x' }, fetchImpl);
    expect(output).toEqual({ isError: true, message: expect.stringMatching(message) as unknown });
  }
});

test('callHubTool rejects only when the request itself fails, an abort included', async () => {
  for (const failure of [
    new TypeError('network down'),
    new DOMException('aborted', 'AbortError'),
  ]) {
    const { fetchImpl } = fakeFetch(enabled(), failure);
    await expect(callHubTool('get_install', { slug: 'x' }, fetchImpl)).rejects.toBe(failure);
  }
});
