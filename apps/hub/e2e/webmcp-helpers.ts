import type { Page } from '@playwright/test';

// What the WebMCP specs share: `e2e/webmcp.spec.ts` (the hub alone, `/mcp` mocked) and
// `e2e-stack/page-tools.spec.ts` (P3-S5: the hub and the real `/mcp` Worker on one origin).

export interface Registered {
  name: string;
  annotations: unknown;
  hasExecute: boolean;
}

export interface PageWindow {
  __webmcp: { tool: { name: string; execute(input: unknown): Promise<unknown> } }[];
}

/** Serve documents with exactly one trial token meta, or with none. */
export async function trialToken(page: Page, present: boolean): Promise<void> {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    const stripped = (await response.text()).replace(/<meta http-equiv="origin-trial"[^>]*>/g, '');
    const body = present
      ? stripped.replace('<head>', '<head><meta http-equiv="origin-trial" content="e2e-token">')
      : stripped;
    await route.fulfill({ response, body });
  });
}

/** A `document.modelContext` that records what the page registers. */
export async function fakeModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as unknown as { __webmcp: unknown[] }).__webmcp = registered;
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool: unknown) {
          registered.push({ tool });
          return Promise.resolve();
        },
      },
    });
  });
}

export function registered(page: Page): Promise<Registered[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __webmcp: { tool: { name: string; annotations: unknown; execute?: unknown } }[];
      }
    ).__webmcp.map(({ tool }) => ({
      name: tool.name,
      annotations: tool.annotations,
      hasExecute: typeof tool.execute === 'function',
    })),
  );
}

/** Everything the page asked the `/mcp` routes for, and everything it complained about. */
export function watch(page: Page) {
  const mcpRequests: string[] = [];
  const problems: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) mcpRequests.push(pathname);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return { mcpRequests, problems };
}
