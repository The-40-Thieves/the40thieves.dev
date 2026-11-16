import { expect, test } from 'vitest';

import { auditDist, auditUrl, parseCsp } from '../scripts/audit-headers.ts';
import { expectedValue, loadPolicy, matchRule } from '../scripts/lib/policy.ts';

const policy = loadPolicy();

const liveHeaders = {
  'strict-transport-security': ' max-age=63072000; includeSubDomains; preload ',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  // The home page's Markdown twin (P3-S2); the policy scopes this rule to `/` exactly.
  link: '</index.md>; rel="alternate"; type="text/markdown"',
};

// A fetch stub that ignores its arguments; a zero-parameter function is assignable to typeof fetch.
const respond = (status: number, headers: Record<string, string>) => (): Promise<Response> =>
  Promise.resolve(new Response('', { status, headers }));

test('dist audit walks nested html and reads _headers', () => {
  expect(auditDist(policy, 'tests/fixtures/dist-good')).toEqual([]);
});

test('dist audit reports a missing header and an unsafe-inline script-src in a nested page', () => {
  const findings = auditDist(policy, 'tests/fixtures/dist-bad');
  expect(findings.map((f) => f.header)).toEqual(
    expect.arrayContaining(['X-Frame-Options', 'script-src']),
  );
  // The root index.html is clean; only nested/index.html carries the forbidden token, so this
  // assertion fails if the walk stops recursing.
  const inline = findings.filter((f) => f.header === 'script-src');
  expect(inline.map((f) => f.where)).toEqual(['tests/fixtures/dist-bad/nested/index.html']);
  expect(inline[0]?.actual).toContain("'unsafe-inline'");
  expect(findings.some((f) => f.header === 'X-Frame-Options' && f.actual === null)).toBe(true);
});

test('parseCsp keeps quoted sources and lower-cases directive names', () => {
  const csp = parseCsp(
    "Default-Src 'self'; script-src 'sha256-abc=' 'strict-dynamic'; upgrade-insecure-requests",
  );
  expect(csp.get('default-src')).toEqual(["'self'"]);
  expect(csp.get('script-src')).toEqual(["'sha256-abc='", "'strict-dynamic'"]);
  expect(csp.get('upgrade-insecure-requests')).toEqual([]);
});

test('url audit is case-insensitive on names and trims values', async () => {
  const good = respond(200, liveHeaders);
  expect(await auditUrl(policy, 'https://x.test', ['/', '/404'], 'static', good)).toEqual([]);
});

test('url audit fails on a redirect instead of following it', async () => {
  const redirect = respond(301, { location: 'https://www.x.test/' });
  const findings = await auditUrl(policy, 'https://x.test', ['/'], 'static', redirect);
  expect(findings[0]?.header).toBe('status');
  expect(findings[0]?.actual).toBe('301');
});

test('url audit reports a header whose value differs', async () => {
  const weak = respond(200, { ...liveHeaders, 'x-frame-options': 'SAMEORIGIN' });
  const findings = await auditUrl(policy, 'https://x.test', ['/'], 'static', weak);
  expect(findings).toEqual([
    {
      where: 'https://x.test/',
      header: 'X-Frame-Options',
      expected: 'DENY',
      actual: 'SAMEORIGIN',
    },
  ]);
});

test('url audit only checks rules for the requested class', async () => {
  const policyWithSsrOnly = {
    ...policy,
    headers: [...policy.headers, { name: 'X-Only-Ssr', value: '1', classes: ['ssr' as const] }],
  };
  // The live set plus every ssr-only header the policy carries (the report-only CSP and its
  // endpoint), so the one header the ssr audit may flag is the fixture's own.
  const ssrOnly = Object.fromEntries(
    policy.headers
      .filter((rule) => rule.classes.includes('ssr') && !rule.classes.includes('static'))
      .map((rule) => [rule.name.toLowerCase(), rule.value]),
  );
  const good = respond(200, { ...liveHeaders, ...ssrOnly });
  expect(await auditUrl(policyWithSsrOnly, 'https://x.test', ['/'], 'static', good)).toEqual([]);
  const ssr = await auditUrl(policyWithSsrOnly, 'https://x.test', ['/'], 'ssr', good);
  expect(ssr.map((f) => f.header)).toEqual(['X-Only-Ssr']);
});
test('url audit checks the relay Worker against the relay class', async () => {
  const relayHeaders = {
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'cross-origin',
  };
  const good = respond(404, relayHeaders);
  expect(await auditUrl(policy, 'https://relay.x.test', ['/=404'], 'relay', good)).toEqual([]);
  // The site's own Referrer-Policy is not the relay's.
  const site = respond(404, {
    ...relayHeaders,
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  const findings = await auditUrl(policy, 'https://relay.x.test', ['/=404'], 'relay', site);
  expect(findings.map((f) => [f.header, f.expected])).toEqual([['Referrer-Policy', 'no-referrer']]);
});

test('URL audit retries a fetch that throws, such as DNS that has not propagated yet', async () => {
  const good = respond(200, liveHeaders);
  let calls = 0;
  const flaky: typeof fetch = () => {
    calls += 1;
    if (calls < 3) throw new Error('getaddrinfo ENOTFOUND x.test');
    return good();
  };
  const slept: number[] = [];
  const findings = await auditUrl(policy, 'https://x.test', ['/'], 'static', flaky, {
    attempts: 5,
    delayMs: 50,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  expect(findings).toEqual([]);
  expect(calls).toBe(3);
  expect(slept).toEqual([50, 50]);
});

test('URL audit gives up after the configured attempts and rethrows the last error', async () => {
  let calls = 0;
  const down: typeof fetch = () => {
    calls += 1;
    throw new Error('getaddrinfo ENOTFOUND x.test');
  };
  await expect(
    auditUrl(policy, 'https://x.test', ['/'], 'static', down, {
      attempts: 3,
      delayMs: 1,
      sleep: () => Promise.resolve(),
    }),
  ).rejects.toThrow('ENOTFOUND');
  expect(calls).toBe(3);
});

test('URL audit accepts a per-path expected status written as path=status', async () => {
  const byPath: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const status = url.endsWith('/nope') ? 404 : 200;
    return Promise.resolve(new Response('', { status, headers: liveHeaders }));
  };
  const findings = await auditUrl(
    policy,
    'https://x.test',
    ['/', '/404', '/nope=404'],
    'static',
    byPath,
  );
  expect(findings).toEqual([]);
});

test('URL audit still checks headers on a path whose expected status is not 200', async () => {
  const weak404: typeof fetch = () =>
    Promise.resolve(
      new Response('', {
        status: 404,
        headers: { ...liveHeaders, 'x-frame-options': 'SAMEORIGIN' },
      }),
    );
  const findings = await auditUrl(policy, 'https://x.test', ['/nope=404'], 'static', weak404);
  expect(findings).toEqual([
    {
      where: 'https://x.test/nope',
      header: 'X-Frame-Options',
      expected: 'DENY',
      actual: 'SAMEORIGIN',
    },
  ]);
});

test('URL audit reports a 200 where a 404 was expected', async () => {
  const findings = await auditUrl(
    policy,
    'https://x.test',
    ['/nope=404'],
    'static',
    respond(200, liveHeaders),
  );
  expect(findings).toEqual([
    { where: 'https://x.test/nope', header: 'status', expected: '404', actual: '200' },
  ]);
});

test('URL audit rejects a path spec whose status is not a number', async () => {
  await expect(
    auditUrl(policy, 'https://x.test', ['/nope=gone'], 'static', respond(200, liveHeaders)),
  ).rejects.toThrow('Bad path spec');
});

test('URL audit re-runs a pass with findings until the attempts run out, then reports the last pass', async () => {
  let calls = 0;
  const missing: typeof fetch = () => {
    calls += 1;
    return respond(404, liveHeaders)();
  };
  const slept: number[] = [];
  const findings = await auditUrl(policy, 'https://x.test', ['/'], 'static', missing, {
    attempts: 5,
    delayMs: 7,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  expect(findings.map((f) => f.header)).toEqual(['status']);
  expect(calls).toBe(5);
  expect(slept).toEqual([7, 7, 7, 7]);
});

test('URL audit passes once a Worker version that was still propagating answers correctly', async () => {
  // Right after `wrangler deploy` returns, the edge can still serve the previous version: new
  // assets 404 and new headers are missing. The deploy audit must wait that out.
  let pass = 0;
  const propagating: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/AGENTS.md')) pass += 1;
    if (pass < 3) {
      if (url.endsWith('/AGENTS.md')) return respond(404, liveHeaders)();
      return respond(200, liveHeaders)();
    }
    if (url.endsWith('/AGENTS.md')) {
      return respond(200, { ...liveHeaders, 'content-type': 'text/markdown; charset=utf-8' })();
    }
    return respond(200, {
      ...liveHeaders,
      link: '</index.md>; rel="alternate"; type="text/markdown"',
    })();
  };
  const findings = await auditUrl(
    policy,
    'https://x.test',
    ['/', '/AGENTS.md'],
    'static',
    propagating,
    {
      attempts: 5,
      delayMs: 1,
      sleep: () => Promise.resolve(),
    },
  );
  expect(findings).toEqual([]);
  expect(pass).toBe(3);
});

test('URL audit rejects a retry policy whose attempts or delay are not finite numbers', async () => {
  // Number('abc') from a bad --retries flag is NaN; a NaN budget never reaches zero.
  let calls = 0;
  const missing: typeof fetch = () => {
    calls += 1;
    return respond(404, liveHeaders)();
  };
  const sleep = () => Promise.resolve();
  await expect(
    auditUrl(policy, 'https://x.test', ['/'], 'static', missing, {
      attempts: Number('abc'),
      delayMs: 1,
      sleep,
    }),
  ).rejects.toThrow('attempts');
  await expect(
    auditUrl(policy, 'https://x.test', ['/'], 'static', missing, {
      attempts: Infinity,
      delayMs: 1,
      sleep,
    }),
  ).rejects.toThrow('attempts');
  await expect(
    auditUrl(policy, 'https://x.test', ['/'], 'static', missing, {
      attempts: 2,
      delayMs: Number('soon'),
      sleep,
    }),
  ).rejects.toThrow('delay');
  expect(calls).toBe(0);
});

test('URL audit shares one attempt budget between request retries and pass retries', async () => {
  let calls = 0;
  const flakyThenMissing: typeof fetch = () => {
    calls += 1;
    if (calls === 1) throw new Error('getaddrinfo ENOTFOUND x.test');
    return respond(404, liveHeaders)();
  };
  const findings = await auditUrl(policy, 'https://x.test', ['/'], 'static', flakyThenMissing, {
    attempts: 3,
    delayMs: 1,
    sleep: () => Promise.resolve(),
  });
  expect(findings.map((f) => f.header)).toEqual(['status']);
  // One throw retry plus one pass retry spend the two sleeps a budget of three attempts allows.
  expect(calls).toBe(3);
});
test('placeholder and splat rules apply to the paths they match, with the value rendered (P3-S2)', async () => {
  const twinLink = '</codecalc.md>; rel="alternate"; type="text/markdown"';
  const page = respond(200, { ...liveHeaders, link: twinLink });
  expect(await auditUrl(policy, 'https://x.test', ['/codecalc/'], 'static', page)).toEqual([]);
  const rootLinkOnly = await auditUrl(
    policy,
    'https://x.test',
    ['/codecalc/'],
    'static',
    respond(200, liveHeaders),
  );
  expect(rootLinkOnly).toEqual([
    {
      where: 'https://x.test/codecalc/',
      header: 'Link',
      expected: twinLink,
      actual: '</index.md>; rel="alternate"; type="text/markdown"',
    },
  ]);
  // `/:page/` never matches a nested path or one without the trailing slash.
  const noLink = Object.fromEntries(
    Object.entries(liveHeaders).filter(([name]) => name !== 'link'),
  );
  for (const path of ['/404', '/nope=404', '/og/banner.svg', '/codecalc/docs/']) {
    const findings = await auditUrl(
      policy,
      'https://x.test',
      [path],
      'static',
      respond(path.endsWith('=404') ? 404 : 200, { ...noLink, 'cache-control': 'no-cache' }),
    );
    expect(
      findings.map((f) => f.header),
      path,
    ).not.toContain('Link');
  }
  const markdown = respond(200, { ...noLink, 'content-type': 'text/markdown; charset=utf-8' });
  expect(
    await auditUrl(policy, 'https://x.test', ['/codecalc.md', '/AGENTS.md'], 'static', markdown),
  ).toEqual([]);
  const mistyped = await auditUrl(
    policy,
    'https://x.test',
    ['/codecalc.md'],
    'static',
    respond(200, { ...noLink, 'content-type': 'text/plain; charset=utf-8' }),
  );
  expect(mistyped).toEqual([
    {
      where: 'https://x.test/codecalc.md',
      header: 'Content-Type',
      expected: 'text/markdown; charset=utf-8',
      actual: 'text/plain; charset=utf-8',
    },
  ]);
  expect(
    matchRule({ name: 'x', value: '', classes: ['static'], path: '/:a/:b.md' }, '/x/y.md'),
  ).toEqual({ a: 'x', b: 'y' });
  expect(
    expectedValue(
      { name: 'x', value: '</:page.md>; rel=":other"', classes: ['static'], path: '/:page/' },
      '/codecalc/',
    ),
  ).toBe('</codecalc.md>; rel=":other"');
  expect(
    expectedValue(
      { name: 'x', value: 'v=:splat', classes: ['static'], path: '/og/*' },
      '/og/card/a.svg',
    ),
  ).toBe('v=card/a.svg');
});

test('a path-scoped rule is checked only on URLs under its path, and never against dist /*', async () => {
  const cards = respond(200, { ...liveHeaders, 'cache-control': 'no-cache' });
  const plain = respond(200, liveHeaders);
  // The committed policy carries Cache-Control for /og/*; the home page must not need it.
  expect(await auditUrl(policy, 'https://x.test', ['/'], 'static', plain)).toEqual([]);
  expect(await auditUrl(policy, 'https://x.test', ['/og/banner.svg'], 'static', cards)).toEqual([]);
  const missing = await auditUrl(policy, 'https://x.test', ['/og/banner.svg'], 'static', plain);
  expect(missing.map((f) => f.header)).toEqual(['Cache-Control']);
  expect(auditDist(policy, 'tests/fixtures/dist-good')).toEqual([]);
});
