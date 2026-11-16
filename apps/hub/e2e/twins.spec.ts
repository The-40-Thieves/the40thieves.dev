import { expect, test } from '@playwright/test';

// P3-S2: wrangler dev serves `_headers` the way production does, so this is where the
// placeholder rule (`/:page/` to `</:page.md>`) and the `.md` content type are proven.
test('a Markdown twin is served as text/markdown with the static headers', async ({ request }) => {
  const response = await request.get('/codecalc.md');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect((await response.text()).startsWith('# codecalc\n')).toBe(true);
});

test('every HTML page carries a Link header to its twin', async ({ request }) => {
  for (const [path, twin] of [
    ['/', '/index.md'],
    ['/codecalc/', '/codecalc.md'],
    ['/changelog/', '/changelog.md'],
    ['/design/library/', '/design/library.md'],
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['link'], path).toBe(
      `<${twin}>; rel="alternate"; type="text/markdown"`,
    );
  }
});

test('AGENTS.md and llms-full.txt are served as text', async ({ request }) => {
  const agents = await request.get('/AGENTS.md');
  expect(agents.status()).toBe(200);
  expect(agents.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect((await agents.text()).startsWith('# AGENTS.md\n')).toBe(true);
  const full = await request.get('/llms-full.txt');
  expect(full.status()).toBe(200);
  expect(full.headers()['content-type']).toContain('text/plain');
  expect((await full.text()).startsWith('# The 40 Thieves: full content\n')).toBe(true);
});
