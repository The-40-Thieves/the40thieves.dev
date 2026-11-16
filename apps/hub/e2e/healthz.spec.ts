import { expect, test } from '@playwright/test';

// /healthz is the one on-demand route (P2-12): synthetic checks read it, and `?boom=1` throws so
// the Sentry wiring can be exercised end to end without a real failure.
test('/healthz answers JSON with the build commit and the ssr headers', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  const body = (await response.json()) as { status: string; commit: string; built_at: string };
  expect(body.status).toBe('ok');
  expect(body.commit).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
  expect(Date.parse(body.built_at)).not.toBeNaN();
});

test('/healthz?boom=1 without the token is an ordinary healthy answer', async ({ request }) => {
  const response = await request.get('/healthz?boom=1');
  expect(response.status()).toBe(200);
  const wrong = await request.get('/healthz?boom=1', { headers: { 'x-healthz-boom': 'nope' } });
  expect(wrong.status()).toBe(200);
});

test('/healthz?boom=1 with the token is a 500 that keeps the ssr headers and shows no stack', async ({
  request,
}) => {
  const response = await request.get('/healthz?boom=1', {
    headers: { 'x-healthz-boom': 'e2e-boom' },
  });
  expect(response.status()).toBe(500);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  const text = await response.text();
  expect(text).not.toContain('healthz.ts');
  expect(text).not.toContain('at ');
});
