import { expect, test, type Page, type Route } from '@playwright/test';

// P4-S4 acceptance, in a real browser against the built site under wrangler dev (so the
// page's `_headers` policy is the production one). No request leaves the machine: every upstream
// (the three browser-direct APIs, the relay, Turnstile, the model provider) is answered here
// with the shape the real one returns.

const PAGE = '/alexandria/try/';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'retry-after, x-quota-remaining',
};

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const ARXIV_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-02T00:00:00Z</published>
<title>Relay result from arXiv</title><summary>An abstract that came through the relay.</summary>
<author><name>R. Elay</name></author></entry></feed>`;

interface Seen {
  relayTargets: string[];
  relaySessions: string[];
  cspReports: number;
  answerBodies: string[];
}

async function mockUpstreams(page: Page): Promise<Seen> {
  const seen: Seen = { relayTargets: [], relaySessions: [], cspReports: 0, answerBodies: [] };

  await page.route('**/csp-report', (route) => {
    seen.cspReports += 1;
    return route.fulfill({ status: 204 });
  });
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = {
        render(el, opts) { setTimeout(() => opts.callback('XXXX.DUMMY.TOKEN.XXXX'), 10); return 'w1'; },
        remove() {},
      };`,
    }),
  );
  await page.route('https://api.openalex.org/**', (route) =>
    json(route, {
      results: [
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.1/direct',
          display_name: 'Direct result from OpenAlex',
          publication_year: 2023,
          authorships: [{ author: { display_name: 'D. Irect' } }],
          abstract_inverted_index: { Fetched: [0], directly: [1] },
        },
      ],
    }),
  );
  await page.route('https://api.crossref.org/**', (route) =>
    json(route, { message: { items: [] } }),
  );
  await page.route('https://www.ebi.ac.uk/**', (route) =>
    json(route, { resultList: { result: [] } }),
  );
  await page.route('https://relay.the40thieves.dev/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (url.pathname === '/v1/session') {
      expect(request.postDataJSON()).toEqual({ token: 'XXXX.DUMMY.TOKEN.XXXX' });
      return json(route, { session: 'v1.e2e', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    const headers = request.headers();
    const target = headers['x-relay-target'] ?? '';
    seen.relayTargets.push(target);
    seen.relaySessions.push(headers['x-relay-session'] ?? '');
    const host = new URL(target).hostname;
    if (host === 'export.arxiv.org') {
      return route.fulfill({
        headers: { ...CORS, 'content-type': 'application/atom+xml' },
        body: ARXIV_FEED,
      });
    }
    if (host === 'api.semanticscholar.org') return json(route, { data: [] });
    if (host === 'content.guardianapis.com') {
      return json(route, { response: { results: [] } }, 200, { 'x-quota-remaining': '29' });
    }
    if (host === 'www.courtlistener.com') {
      return json(route, { error: 'quota_reached' }, 429, { 'retry-after': '7200' });
    }
    return json(route, { error: 'host_not_allowed' }, 403);
  });
  await page.route('https://api.anthropic.com/**', (route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS });
    seen.answerBodies.push(route.request().postData() ?? '');
    return json(route, {
      content: [{ type: 'text', text: 'Fetched directly [1], and via the relay [2].' }],
    });
  });
  // Count violations the page sees itself too: report-to may batch out of band.
  await page.addInitScript(() => {
    const store = window as unknown as { violations: string[] };
    store.violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return seen;
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { violations: string[] }).violations);
}

test('the page carries the enforcing, reporting policy from _headers', async ({ request }) => {
  const response = await request.get(PAGE);
  expect(response.status()).toBe(200);
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('report-uri /csp-report');
  expect(csp).not.toContain('posthog');
  expect(response.headers()['reporting-endpoints']).toBe('csp-endpoint="/csp-report"');
});

test('a full session: search with a visitor key, results from a direct and a relay source, a cited answer, no CSP report', async ({
  page,
}) => {
  const seen = await mockUpstreams(page);
  await page.goto(PAGE);
  await page.getByLabel('Anthropic API key').fill('sk-ant-e2e-visitor-key');
  await page.getByLabel('CORE API key', { exact: false }).fill('core-e2e-key');
  await page.getByLabel('Question or keywords').fill('relay test');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('link', { name: 'Direct result from OpenAlex' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Relay result from arXiv' })).toBeVisible();
  await expect(page.locator('[data-source="courtlistener"]')).toContainText('resets in about 2 h');
  await expect(page.locator('[data-source="guardian"]')).toContainText('0 results');

  // The relay saw the minted session and the visitor's CORE key only on the CORE call.
  expect(new Set(seen.relaySessions)).toEqual(new Set(['v1.e2e']));
  expect(seen.relayTargets.map((target) => new URL(target).hostname).sort()).toEqual([
    'api.core.ac.uk',
    'api.semanticscholar.org',
    'content.guardianapis.com',
    'export.arxiv.org',
    'www.courtlistener.com',
  ]);

  await page.locator('summary', { hasText: 'Read' }).first().click();
  await expect(page.getByText('Fetched directly', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Answer with citations' }).click();
  const answer = page.getByTestId('answer');
  await expect(answer).toContainText('Fetched directly');
  await expect(answer.getByRole('link', { name: '[1]' })).toHaveAttribute('href', '#cite-1');
  await expect(answer.locator('#cite-1')).toContainText('Direct result from OpenAlex');
  expect(seen.answerBodies).toHaveLength(1);
  expect(seen.answerBodies[0]).toContain('Relay result from arXiv');

  expect(await violations(page)).toEqual([]);
  expect(seen.cspReports).toBe(0);
});

test('a reload without the opt-in forgets the key; with it the tab keeps it', async ({ page }) => {
  await mockUpstreams(page);
  await page.goto(PAGE);
  const key = page.getByLabel('Anthropic API key');
  await key.fill('sk-ant-forget-me');
  await page.reload();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('sk-ant');

  await page.getByLabel('Anthropic API key').fill('sk-ant-keep-me');
  await page.getByLabel('Keep my keys for this tab', { exact: false }).check();
  await page.reload();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('sk-ant-keep-me');

  await page.getByRole('button', { name: 'Forget keys' }).click();
  await page.reload();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('');
  expect(await violations(page)).toEqual([]);
});
