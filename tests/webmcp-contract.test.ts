import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkSurfaces, MCP_TOOL_NAMES } from '@the40thieves/manifest';
import {
  PAGE_PROTOCOL_VERSION,
  pageDeclaredTools,
  pageRpcRequest,
  WEBMCP_PATH,
  WEBMCP_TOOL_NAMES,
  WEBMCP_TOOLS_META,
  webmcpToolsFor,
} from '@the40thieves/manifest/webmcp';
import type { Manifest } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

// P3-S4: the tools a page registers through WebMCP are a
// subset of the manifest's `/mcp` tools, decided per route in one place.
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../workers/mcp/tests/fixtures/manifest.json'), 'utf8'),
) as Manifest;

const HUB = ['search_projects', 'get_install'];

test('every hub page offers the hub pair and document pages add read_doc', () => {
  expect(webmcpToolsFor('/')).toEqual(HUB);
  expect(webmcpToolsFor('/codecalc/')).toEqual([...HUB, 'read_doc']);
  expect(webmcpToolsFor('/changelog/')).toEqual([...HUB, 'read_doc']);
});

test('the 404 page and anything that is not a hub page offer nothing', () => {
  expect(webmcpToolsFor('/404/')).toEqual([]);
  expect(webmcpToolsFor('/codecalc/docs/')).toEqual([]);
  expect(webmcpToolsFor('/codecalc')).toEqual([]);
  expect(webmcpToolsFor('')).toEqual([]);
});

test('the page tools are three of the /mcp tools, in a fixed order', () => {
  expect(WEBMCP_TOOL_NAMES).toEqual(['search_projects', 'get_install', 'read_doc']);
  for (const name of WEBMCP_TOOL_NAMES) expect(MCP_TOOL_NAMES, name).toContain(name);
  expect(WEBMCP_PATH).toBe('/mcp/webmcp');
});

test('a page tools/call carries the 2026-07-28 headers and envelope', () => {
  const { headers, body } = pageRpcRequest('tools/call', {
    name: 'get_install',
    arguments: { slug: 'codecalc', client: 'shell' },
  });
  expect(headers).toEqual({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PAGE_PROTOCOL_VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': 'get_install',
  });
  expect(JSON.parse(body)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'get_install',
      arguments: { slug: 'codecalc', client: 'shell' },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });
});

test('a page tools/list names no tool in its headers', () => {
  const { headers, body } = pageRpcRequest('tools/list', {});
  expect(headers['mcp-method']).toBe('tools/list');
  expect(headers).not.toHaveProperty('mcp-name');
  expect((JSON.parse(body) as { method: string }).method).toBe('tools/list');
});

test('pageDeclaredTools reads the tools meta of a built page', () => {
  expect(WEBMCP_TOOLS_META).toBe('webmcp-tools');
  const html = `<head><meta name="webmcp-tools" content="search_projects get_install"></head>`;
  expect(pageDeclaredTools(html)).toEqual(['search_projects', 'get_install']);
  expect(pageDeclaredTools(`<meta content="read_doc" name="webmcp-tools" />`)).toEqual([
    'read_doc',
  ]);
  expect(pageDeclaredTools('<head><title>x</title></head>')).toEqual([]);
  expect(pageDeclaredTools('<meta name="webmcp-tools" content="">')).toEqual([]);
});

const inputs = { pages: new Map<string, string>(), llmsTxt: null };

test('the webmcp surface is clean when every page declares what its route offers', () => {
  const webmcp = new Map([
    ['/', webmcpToolsFor('/')],
    ['/codecalc/', webmcpToolsFor('/codecalc/')],
    ['/404/', webmcpToolsFor('/404/')],
  ]);
  expect(checkSurfaces(manifest, { ...inputs, webmcp, webmcpServed: WEBMCP_TOOL_NAMES })).toEqual(
    [],
  );
});

test('a page declaring a tool the manifest does not list is a violation', () => {
  const trimmed: Manifest = {
    ...manifest,
    mcp: {
      ...manifest.mcp,
      tools: manifest.mcp.tools.filter((tool) => tool.name !== 'get_install'),
    },
  };
  expect(checkSurfaces(trimmed, { ...inputs, webmcp: new Map([['/', HUB]]) })).toEqual([
    {
      surface: 'webmcp',
      where: '/',
      detail: 'declares get_install, which is not in manifest.mcp.tools',
    },
  ]);
});

test('a page declaring a tool its route does not offer is a violation', () => {
  expect(
    checkSurfaces(manifest, { ...inputs, webmcp: new Map([['/', [...HUB, 'compare_projects']]]) }),
  ).toEqual([
    {
      surface: 'webmcp',
      where: '/',
      detail: 'declares compare_projects, which the route map does not offer on this page',
    },
  ]);
});

test('a served page tool outside the manifest or the subset is a violation', () => {
  expect(
    checkSurfaces(manifest, { ...inputs, webmcpServed: ['search_projects', 'rm_rf'] }),
  ).toEqual([
    { surface: 'webmcp', where: 'rm_rf', detail: 'served page tool is not in manifest.mcp.tools' },
    { surface: 'webmcp', where: 'rm_rf', detail: 'served page tool is not a WebMCP page tool' },
  ]);
  expect(checkSurfaces(manifest, { ...inputs, webmcpServed: ['compare_projects'] })).toEqual([
    {
      surface: 'webmcp',
      where: 'compare_projects',
      detail: 'served page tool is not a WebMCP page tool',
    },
  ]);
});
