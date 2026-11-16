import { expect, test } from '@playwright/test';

import {
  fakeModelContext,
  type PageWindow,
  registered,
  trialToken,
  watch,
} from '../e2e/webmcp-helpers.ts';

// P3-S5: the page tools end to end. `e2e/webmcp.spec.ts` mocks the `/mcp` Worker, because
// `wrangler dev` for the hub has none; here the hub and the Worker answer on one origin
// (`scripts/agent-stack.ts`), so the list a page registers and the answer a tool returns are the
// Worker's own. The browser API is still a recording stand-in: Playwright's Chromium has no
// `document.modelContext`.

test('a project page registers the tools /mcp/webmcp lists, and a call returns the Worker’s answer', async ({
  page,
}) => {
  await trialToken(page, true);
  await fakeModelContext(page);
  const { mcpRequests, problems } = watch(page);

  await page.goto('/codecalc/');
  await expect
    .poll(async () => (await registered(page)).map((tool) => tool.name))
    .toEqual(['search_projects', 'get_install', 'read_doc']);

  const output = await page.evaluate(() =>
    (window as unknown as PageWindow).__webmcp
      .find(({ tool }) => tool.name === 'search_projects')
      ?.tool.execute({ query: 'calc' }),
  );
  // A real POST from the page, with the browser's own Origin, answered from the seeded manifest.
  const { results } = output as { results: { slug: string }[] };
  // Which project ranks first depends on what the organisation has published; that it is found
  // does not.
  expect(results.map((result) => result.slug)).toContain('codecalc');
  expect(mcpRequests).toEqual(['/mcp/webmcp', '/mcp']);
  expect(problems).toEqual([]);
});
