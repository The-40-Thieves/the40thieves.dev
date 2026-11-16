import { expect, test } from 'vitest';

import { exportZone, type ZoneExport } from '../scripts/edge-config.ts';

// The drift export must cover what P2-02 configured in the dashboard's domain: the managed WAF
// entry point, DNSSEC, the HSTS zone setting and the AI crawler policy, next to the DNS records,
// custom rules, redirects and Worker routes it already tracked. A fake getter stands in for the
// API so the shape is pinned without a token.

const zone = { name: 'example.test', id: 'zone1' } as const;

const live: Record<string, unknown> = {
  '/zones/zone1/dns_records?per_page=500': [
    {
      type: 'CAA',
      name: 'example.test',
      content: '0 issue "letsencrypt.org"',
      ttl: 1,
      comment: 'c',
    },
    { type: 'AAAA', name: 'example.test', content: '100::', proxied: true, ttl: 1 },
  ],
  '/zones/zone1/rulesets/phases/http_request_firewall_custom/entrypoint': null,
  '/zones/zone1/rulesets/phases/http_request_dynamic_redirect/entrypoint': { rules: [] },
  '/zones/zone1/rulesets/phases/http_request_firewall_managed/entrypoint': {
    id: 'rs1',
    version: '3',
    rules: [
      {
        id: 'r1',
        ref: 'r1',
        version: '1',
        last_updated: 'now',
        action: 'execute',
        action_parameters: { id: '77454fe2d30c4220b5701f6fdfb893ba', version: 'latest' },
        expression: 'true',
        description: 'Execute the Cloudflare Managed Free Ruleset',
        enabled: true,
      },
    ],
  },
  '/zones/zone1/workers/routes': [{ pattern: 'example.test/docs*', script: 'docs' }],
  '/zones/zone1/dnssec': {
    status: 'active',
    ds: 'example.test. 3600 IN DS 2371 13 2 ABCD',
    key_tag: 2371,
  },
  '/zones/zone1/settings/security_header': {
    id: 'security_header',
    modified_on: 'now',
    value: {
      strict_transport_security: {
        enabled: true,
        max_age: 63072000,
        include_subdomains: true,
        preload: true,
        nosniff: true,
      },
    },
  },
  '/zones/zone1/bot_management': {
    enable_js: false,
    fight_mode: false,
    ai_bots_protection: 'disabled',
    content_bots_protection: 'disabled',
    crawler_protection: 'disabled',
    ai_training: 'disallow',
    ai_search: 'disabled',
    ai_user: 'disabled',
    ai_agents: { anthropic_agent: 'disabled', openai_agent: 'disabled' },
    is_robots_txt_managed: true,
    bot_preference_sync_enabled: true,
    cf_robots_variant: 'off',
    ai_bots_migration_opt_out: false,
    using_latest_model: true,
  },
};

const get = (path: string): Promise<unknown> => {
  if (!(path in live)) throw new Error(`unexpected GET ${path}`);
  return Promise.resolve(live[path]);
};

test('exportZone captures the managed WAF entry point without its volatile fields', async () => {
  const out = await exportZone(zone, get);
  expect(out.waf_managed_rules).toEqual([
    {
      action: 'execute',
      action_parameters: { id: '77454fe2d30c4220b5701f6fdfb893ba' },
      description: 'Execute the Cloudflare Managed Free Ruleset',
      enabled: true,
      expression: 'true',
    },
  ]);
});

test('exportZone captures DNSSEC, the HSTS zone setting and the AI crawler policy', async () => {
  const out = await exportZone(zone, get);
  expect(out.dnssec).toEqual({ status: 'active', ds: 'example.test. 3600 IN DS 2371 13 2 ABCD' });
  expect(out.settings).toEqual({
    security_header: {
      strict_transport_security: {
        enabled: true,
        include_subdomains: true,
        max_age: 63072000,
        nosniff: true,
        preload: true,
      },
    },
  });
  expect(out.bot_management).toEqual({
    ai_agents: { anthropic_agent: 'disabled', openai_agent: 'disabled' },
    ai_bots_protection: 'disabled',
    ai_search: 'disabled',
    ai_training: 'disallow',
    ai_user: 'disabled',
    bot_preference_sync_enabled: true,
    cf_robots_variant: 'off',
    content_bots_protection: 'disabled',
    crawler_protection: 'disabled',
    enable_js: false,
    fight_mode: false,
    is_robots_txt_managed: true,
  });
});

test('exportZone keeps the earlier sections and their ordering rules', async () => {
  const out = await exportZone(zone, get);
  expect(Object.keys(out)).toEqual([
    'zone',
    'dns',
    'waf_custom_rules',
    'waf_managed_rules',
    'redirect_rules',
    'worker_routes',
    'dnssec',
    'settings',
    'bot_management',
  ] satisfies (keyof ZoneExport)[]);
  expect(out.dns.map((r) => (r as { type: string }).type)).toEqual(['AAAA', 'CAA']);
  expect(out.dns[1]).toEqual({
    type: 'CAA',
    name: 'example.test',
    content: '0 issue "letsencrypt.org"',
    proxied: false,
    ttl: 1,
    comment: 'c',
  });
  expect(out.waf_custom_rules).toEqual([]);
  expect(out.worker_routes).toEqual([{ pattern: 'example.test/docs*', script: 'docs' }]);
});
