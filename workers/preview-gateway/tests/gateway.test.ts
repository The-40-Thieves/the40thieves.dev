import { expect, test } from 'vitest';

import {
  HEALTH_PATH,
  handleRequest,
  MAX_BODY_BYTES,
  previewNumber,
  type Fetcher,
} from '../src/gateway.ts';

const SUFFIX = '-hub.example-sub.workers.dev';
const env = { PREVIEW_ORIGIN_SUFFIX: SUFFIX };

function recording(response: Response): { fetcher: Fetcher; seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    fetcher: (request) => {
      seen.push(request);
      return Promise.resolve(response);
    },
  };
}

test('only pr-<n> hosts on the zone are preview hosts', () => {
  expect(previewNumber('pr-60-preview.the40thieves.dev')).toBe('60');
  expect(previewNumber('PR-7-Preview.The40Thieves.dev')).toBe('7');
  expect(previewNumber('pr-0-preview.the40thieves.dev')).toBeNull();
  expect(previewNumber('pr-60-preview.the40thieves.dev.evil.test')).toBeNull();
  expect(previewNumber('pr-60.the40thieves.dev')).toBeNull();
  expect(previewNumber('x-preview.the40thieves.dev')).toBeNull();
  expect(previewNumber('www.the40thieves.dev')).toBeNull();
  expect(previewNumber('the40thieves.dev')).toBeNull();
});

test('any other host is a 404 and never reaches upstream', async () => {
  const { fetcher, seen } = recording(new Response('x'));
  const response = await handleRequest(
    new Request('https://foo-preview.the40thieves.dev/'),
    env,
    fetcher,
  );
  expect(response.status).toBe(404);
  expect(seen).toHaveLength(0);
});

test('a missing or malformed suffix is a 503 that does not echo it', async () => {
  const { fetcher, seen } = recording(new Response('x'));
  for (const bad of [undefined, '', 'evil.test', '-hub.sub.workers.dev/../x']) {
    const response = await handleRequest(
      new Request('https://pr-1-preview.the40thieves.dev/'),
      { PREVIEW_ORIGIN_SUFFIX: bad },
      fetcher,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('workers.dev');
  }
  expect(seen).toHaveLength(0);
});

test('proxies path, query, method and body to the alias, without following redirects', async () => {
  const { fetcher, seen } = recording(new Response('ok', { status: 201 }));
  const response = await handleRequest(
    new Request('https://pr-60-preview.the40thieves.dev/alexandria/try?q=a%20b', {
      method: 'POST',
      body: 'payload',
      headers: { 'content-type': 'text/plain', host: 'pr-60-preview.the40thieves.dev' },
    }),
    env,
    fetcher,
  );
  expect(response.status).toBe(201);
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const [upstream] = seen;
  expect(upstream?.url).toBe(`https://pr-60${SUFFIX}/alexandria/try?q=a%20b`);
  expect(upstream?.method).toBe('POST');
  expect(upstream?.redirect).toBe('manual');
  expect(await upstream?.text()).toBe('payload');
});

test('redirects to the upstream host come back on the public host', async () => {
  for (const location of [`https://pr-60${SUFFIX}/next/?a=1`, '/next/?a=1']) {
    const { fetcher } = recording(new Response(null, { status: 301, headers: { location } }));
    const response = await handleRequest(
      new Request('https://pr-60-preview.the40thieves.dev/next'),
      env,
      fetcher,
    );
    expect(response.headers.get('location')).toBe(
      'https://pr-60-preview.the40thieves.dev/next/?a=1',
    );
  }
});

test('redirects to other hosts are left alone', async () => {
  const { fetcher } = recording(
    new Response(null, { status: 302, headers: { location: 'https://github.com/x' } }),
  );
  const response = await handleRequest(
    new Request('https://pr-60-preview.the40thieves.dev/gh'),
    env,
    fetcher,
  );
  expect(response.headers.get('location')).toBe('https://github.com/x');
});

test('a path that looks like an authority stays a path on the alias', async () => {
  for (const path of ['//evil.test/x', '//evil.test:443/x?y=1', '/..//evil.test/x']) {
    const { fetcher, seen } = recording(new Response('ok'));
    // A Request normalises its URL, so the raw path is set the way a client could send it.
    const request = new Request('https://pr-60-preview.the40thieves.dev/');
    Object.defineProperty(request, 'url', {
      value: `https://pr-60-preview.the40thieves.dev${path}`,
    });
    await handleRequest(request, env, fetcher);
    expect(new URL(seen[0]?.url ?? 'https://none').host).toBe(`pr-60${SUFFIX}`);
  }
});

test('a body over the cap is a 413 and never reaches upstream', async () => {
  const { fetcher, seen } = recording(new Response('ok'));
  const big = 'x'.repeat(MAX_BODY_BYTES + 1);
  const variants: Record<string, string>[] = [{}, { 'content-length': String(MAX_BODY_BYTES + 1) }];
  for (const headers of variants) {
    const response = await handleRequest(
      new Request('https://pr-60-preview.the40thieves.dev/csp-report', {
        method: 'POST',
        body: big,
        headers,
      }),
      env,
      fetcher,
    );
    expect(response.status).toBe(413);
  }
  expect(seen).toHaveLength(0);
});

test('the health path reports whether the suffix is usable, without a live alias', async () => {
  const { fetcher, seen } = recording(new Response('x'));
  const url = `https://deploy-check-preview.the40thieves.dev${HEALTH_PATH}`;
  expect((await handleRequest(new Request(url), env, fetcher)).status).toBe(200);
  const bad = await handleRequest(new Request(url), { PREVIEW_ORIGIN_SUFFIX: 'nope' }, fetcher);
  expect(bad.status).toBe(503);
  expect(seen).toHaveLength(0);
});
