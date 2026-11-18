import { expect, test } from 'vitest';

import { PAUSE_RETRY_AFTER_SECONDS } from '../../../security/pause-flag.ts';
import { gateTryPage, isGatedPath, isTryPage, PAUSED_HTML } from '../src/lib/pause-gate.ts';

const SITE = 'https://the40thieves.dev';

function gate(options: { paused: boolean }) {
  const served: string[] = [];
  let reads = 0;
  const send = (path: string, method = 'GET'): Promise<Response> =>
    gateTryPage(new Request(`${SITE}${path}`, { method }), {
      paused: () => {
        reads += 1;
        return Promise.resolve(options.paused);
      },
      assets: (request) => {
        served.push(new URL(request.url).pathname);
        return Promise.resolve(new Response('the app', { status: 200 }));
      },
      stamp: (response) => {
        const headers = new Headers(response.headers);
        headers.set('x-stamped', 'ssr');
        return new Response(response.body, { status: response.status, headers });
      },
    });
  return { send, served, reads: () => reads };
}

test('the gated paths are the page and everything under it, and nothing else', () => {
  for (const path of ['/alexandria/try', '/alexandria/try/', '/alexandria/try/icon.svg']) {
    expect(isGatedPath(path), path).toBe(true);
  }
  for (const path of ['/alexandria/try.md', '/alexandria/trying/', '/alexandria/sources/', '/']) {
    expect(isGatedPath(path), path).toBe(false);
  }
  expect(isTryPage('/alexandria/try/')).toBe(true);
  expect(isTryPage('/alexandria/try/manifest.webmanifest')).toBe(false);
});

test('not paused: the page is the file from the assets binding', async () => {
  const g = gate({ paused: false });
  const response = await g.send('/alexandria/try/');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('the app');
  expect(g.served).toEqual(['/alexandria/try/']);
});

test('paused: the page is a static 503 that loads nothing', async () => {
  const g = gate({ paused: true });
  for (const path of ['/alexandria/try', '/alexandria/try/', '/alexandria/try/index.html']) {
    const response = await g.send(path);
    expect(response.status, path).toBe(503);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe(String(PAUSE_RETRY_AFTER_SECONDS));
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('x-stamped')).toBe('ssr');
    expect(await response.text()).toBe(PAUSED_HTML);
  }
  expect(g.served).toEqual([]);
  expect(PAUSED_HTML).toContain('<h1>Try alexandria is paused</h1>');
  expect(PAUSED_HTML).not.toMatch(/<script|<link|<style|style=|<img|<iframe/);
});

test('paused: HEAD answers the same status with no body', async () => {
  const response = await gate({ paused: true }).send('/alexandria/try/', 'HEAD');
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('');
});

test('paused: the manifest, the icon and other methods are still the file, with no flag read', async () => {
  const g = gate({ paused: true });
  await g.send('/alexandria/try/manifest.webmanifest');
  await g.send('/alexandria/try/icon.svg');
  await g.send('/alexandria/try/', 'POST');
  expect(g.served).toEqual([
    '/alexandria/try/manifest.webmanifest',
    '/alexandria/try/icon.svg',
    '/alexandria/try/',
  ]);
  expect(g.reads()).toBe(0);
});
