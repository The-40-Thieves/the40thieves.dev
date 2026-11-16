import { expect, test } from 'vitest';

import { loadPolicy } from '../../../scripts/lib/policy.ts';
import { withRouteHeaders } from '../src/lib/route-headers.ts';

const policy = loadPolicy();

test('withRouteHeaders adds every ssr-class header from the policy to a response', () => {
  const response = withRouteHeaders(new Response('{}', { status: 200 }), policy, 'ssr');
  for (const rule of policy.headers.filter((rule) => rule.classes.includes('ssr'))) {
    expect(response.headers.get(rule.name), rule.name).toBe(rule.value);
  }
});

test('withRouteHeaders keeps the status, body and existing headers', async () => {
  const original = new Response('ok', {
    status: 503,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
  const response = withRouteHeaders(original, policy, 'ssr');
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('ok');
  expect(response.headers.get('content-type')).toBe('text/plain');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('withRouteHeaders leaves headers of another class out', () => {
  const staticOnly = {
    ...policy,
    headers: [{ name: 'X-Only-Static', value: '1', classes: ['static' as const] }],
  };
  const response = withRouteHeaders(new Response(''), staticOnly, 'ssr');
  expect(response.headers.has('X-Only-Static')).toBe(false);
});
