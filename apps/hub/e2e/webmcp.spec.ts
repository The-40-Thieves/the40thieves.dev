import { expect, test, type Page, type Request } from '@playwright/test';

import {
  fakeModelContext,
  type PageWindow,
  registered,
  trialToken,
  watch,
} from './webmcp-helpers.ts';

// P3-S4: WebMCP page tools in a real browser. The trial token meta is added to (or removed
// from) the served HTML here, so the checks do not depend on which tokens are committed, and the
// `/mcp` Worker (not part of `wrangler dev` for the hub) is mocked at the network.

const DEFINITIONS = [
  { name: 'search_projects', description: 'Search.', inputSchema: { type: 'object' } },
  { name: 'get_install', description: 'Install.', inputSchema: { type: 'object' } },
  { name: 'read_doc', description: 'Read.', inputSchema: { type: 'object' } },
];

/** No WebMCP at all, whatever this Chromium build ships. */
async function noModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'modelContext', { configurable: true, value: undefined });
  });
}

async function mockPageTools(page: Page, reply: unknown): Promise<void> {
  await page.route('**/mcp/webmcp', (route) => route.fulfill({ json: reply }));
}

test('without the browser API a page with a trial token requests nothing and logs nothing', async ({
  page,
}) => {
  await trialToken(page, true);
  await noModelContext(page);
  const { mcpRequests, problems } = watch(page);
  const scripts: string[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.push(response.url());
  });
  for (const path of ['/', '/codecalc/']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  expect(mcpRequests).toEqual([]);
  expect(problems).toEqual([]);
  // The registration chunk was never fetched.
  for (const url of scripts) {
    const source = await (await page.request.get(url)).text();
    expect(source, url).not.toContain('untrustedContentHint');
  }
});

test('with the API but no trial token a page requests nothing', async ({ page }) => {
  await trialToken(page, false);
  await fakeModelContext(page);
  const { mcpRequests, problems } = watch(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(mcpRequests).toEqual([]);
  expect(await registered(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test('with the API and a token each route registers its tools, read-only and untrusted', async ({
  page,
}) => {
  await trialToken(page, true);
  await fakeModelContext(page);
  await mockPageTools(page, { enabled: true, tools: DEFINITIONS });
  const { problems } = watch(page);
  const annotations = { readOnlyHint: true, untrustedContentHint: true };

  await page.goto('/');
  await expect
    .poll(async () => (await registered(page)).map((tool) => tool.name))
    .toEqual(['search_projects', 'get_install']);
  expect(await registered(page)).toEqual([
    { name: 'search_projects', annotations, hasExecute: true },
    { name: 'get_install', annotations, hasExecute: true },
  ]);

  await page.goto('/codecalc/');
  await expect
    .poll(async () => (await registered(page)).map((tool) => tool.name))
    .toEqual(['search_projects', 'get_install', 'read_doc']);

  await page.goto('/this-page-does-not-exist/');
  await page.waitForLoadState('networkidle');
  expect(await registered(page)).toEqual([]);
  expect(problems.filter((line) => !line.includes('404'))).toEqual([]);
});

test('executing a registered tool posts the 2026-07-28 request to /mcp and returns the result', async ({
  page,
}) => {
  await trialToken(page, true);
  await fakeModelContext(page);
  await mockPageTools(page, { enabled: true, tools: DEFINITIONS });
  let seen: Request | undefined;
  await page.route(
    (url) => url.pathname === '/mcp',
    async (route) => {
      seen = route.request();
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: '{"results":[]}' }],
            structuredContent: { results: [] },
          },
        },
      });
    },
  );
  await page.goto('/');
  await expect.poll(async () => (await registered(page)).length).toBe(2);
  const output = await page.evaluate(() =>
    (window as unknown as PageWindow).__webmcp[0]?.tool.execute({ query: 'calc' }),
  );
  // The object, not its JSON text: the browser serialises what execute resolves to.
  expect(output).toEqual({ results: [] });
  expect(seen?.method()).toBe('POST');
  const headers = seen?.headers() ?? {};
  expect(headers['mcp-protocol-version']).toBe('2026-07-28');
  expect(headers['mcp-method']).toBe('tools/call');
  expect(headers['mcp-name']).toBe('search_projects');
  expect(headers['content-type']).toBe('application/json');
  expect(seen?.postDataJSON()).toMatchObject({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'search_projects', arguments: { query: 'calc' } },
  });
});

test('the kill switch answer registers nothing and logs nothing', async ({ page }) => {
  await trialToken(page, true);
  await fakeModelContext(page);
  await mockPageTools(page, { enabled: false, tools: [] });
  const { mcpRequests, problems } = watch(page);
  await page.goto('/codecalc/');
  await page.waitForLoadState('networkidle');
  expect(mcpRequests).toEqual(['/mcp/webmcp']);
  expect(await registered(page)).toEqual([]);
  expect(problems).toEqual([]);
});

test('when the Worker does not answer, nothing registers and the page does not throw', async ({
  page,
}) => {
  // `wrangler dev` for the hub has no /mcp Worker: the real answer here is the hub's 404.
  await trialToken(page, true);
  await fakeModelContext(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await registered(page)).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.locator('h1')).toBeVisible();
});
