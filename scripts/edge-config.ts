import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from './lib/policy.ts';

/**
 * Edge-config drift gate (P2-13).
 *
 * Exports what the Cloudflare dashboard could change behind the repository's back, for the
 * .dev and .tech zones: DNS records, WAF custom and managed rules, redirect rules, Worker
 * routes, DNSSEC, the HSTS zone setting and the AI crawler policy (the P2-02 edge controls).
 * The export is committed under `infra/cloudflare/`, and `--check` fails when the live account
 * differs from the committed state, so a manual change in the dashboard fails CI within one
 * run and has to be either reverted or committed on purpose. The .io zone is checked from a
 * private repository, not here.
 *
 * Token: CLOUDFLARE_DRIFT_TOKEN, read-only on the .dev and .tech zones.
 */

const API = 'https://api.cloudflare.com/client/v4';

export const ZONES = [
  { name: 'the40thieves.dev', id: 'f8098b6525449d31cbac4a569bb270d8' },
  { name: 'the40thieves.tech', id: 'bbcd16045c4b84c0fc46acd35127c8fa' },
] as const;

export type Zone = { readonly name: string; readonly id: string };

/** Ruleset phases the dashboard exposes as "WAF custom rules", "Managed rules" and "Redirect rules". */
const PHASES = [
  'http_request_firewall_custom',
  'http_request_firewall_managed',
  'http_request_dynamic_redirect',
] as const;

/** Fields Cloudflare rewrites on every read or edit; none of them is configuration. */
const VOLATILE = new Set([
  'id',
  'ref',
  'version',
  'last_updated',
  'created_on',
  'modified_on',
  'meta',
  'zone_id',
  'zone_name',
  'settings',
]);

/** Bot Management fields that describe Cloudflare's rollout state, not the zone's policy. */
const BOT_TRANSIENT = new Set(['ai_bots_migration_opt_out', 'using_latest_model']);

const OUTPUT_DIR = resolve(repoRoot, 'infra/cloudflare');

function token(): string {
  const value = process.env['CLOUDFLARE_DRIFT_TOKEN'];
  if (!value) throw new Error('CLOUDFLARE_DRIFT_TOKEN is not set');
  return value;
}

/** One API read: the `result` of a zone endpoint, or `null` for a phase with no entry point yet. */
export type Getter = (path: string) => Promise<unknown>;

const apiGet: Getter = async (path) => {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const body = (await response.json()) as {
    success: boolean;
    result: unknown;
    result_info?: { page: number; total_pages: number };
    errors: { code: number; message: string }[];
  };
  if (response.status === 404 && body.errors.some((error) => error.code === 10003)) {
    // No entrypoint ruleset in this phase yet: nothing configured.
    return null;
  }
  if (!response.ok || !body.success) {
    throw new Error(
      `GET ${path}: ${String(response.status)} ${body.errors.map((error) => error.message).join('; ')}`,
    );
  }
  if (body.result_info !== undefined && body.result_info.total_pages > 1) {
    // A list endpoint paginated: the export would silently miss the later pages.
    throw new Error(
      `GET ${path}: ${String(body.result_info.total_pages)} pages, this script reads only the first`,
    );
  }
  return body.result;
};

/**
 * Drop volatile fields recursively and sort object keys so the file is stable. The one `id`
 * that is configuration is the managed ruleset an `execute` rule points at
 * (`action_parameters.id`); its sibling `version` ("latest") is still volatile.
 */
function stable(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) => !VOLATILE.has(key) || (key === 'id' && parentKey === 'action_parameters'),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, stable(inner, key)]),
    );
  }
  return value;
}

interface DnsRecord {
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
  priority?: number;
  comment?: string | null;
}

interface Ruleset {
  rules?: unknown[];
}

interface WorkerRoute {
  pattern: string;
  script?: string;
}

interface Dnssec {
  status: string;
  ds?: string | null;
}

interface ZoneSetting {
  value: unknown;
}

export interface ZoneExport {
  zone: string;
  dns: unknown[];
  waf_custom_rules: unknown[];
  waf_managed_rules: unknown[];
  redirect_rules: unknown[];
  worker_routes: unknown[];
  /** DNSSEC status and the DS record Cloudflare publishes (`null` until signing is on). */
  dnssec: { status: string; ds: string | null };
  /** Zone settings the policy depends on: `security_header` is the HSTS zone setting. */
  settings: { security_header: unknown };
  /** Bot Management: the AI crawler policy and the bot-fight switches, rollout fields dropped. */
  bot_management: unknown;
}

export async function exportZone(zone: Zone, get: Getter = apiGet): Promise<ZoneExport> {
  const dns = ((await get(`/zones/${zone.id}/dns_records?per_page=500`)) as DnsRecord[])
    .map((record) => ({
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: record.proxied ?? false,
      ttl: record.ttl,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
      ...(record.comment ? { comment: record.comment } : {}),
    }))
    .sort((a, b) =>
      `${a.name} ${a.type} ${a.content}`.localeCompare(`${b.name} ${b.type} ${b.content}`),
    );

  const [waf, managed, redirects] = await Promise.all(
    PHASES.map(async (phase) => {
      const ruleset = (await get(
        `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`,
      )) as Ruleset | null;
      return (ruleset?.rules ?? []).map((rule) => stable(rule));
    }),
  );

  const routes = ((await get(`/zones/${zone.id}/workers/routes`)) as WorkerRoute[])
    .map((route) => ({ pattern: route.pattern, script: route.script ?? null }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));

  const dnssec = (await get(`/zones/${zone.id}/dnssec`)) as Dnssec;
  const hsts = (await get(`/zones/${zone.id}/settings/security_header`)) as ZoneSetting;
  const bots = (await get(`/zones/${zone.id}/bot_management`)) as Record<string, unknown>;

  return {
    zone: zone.name,
    dns,
    waf_custom_rules: waf ?? [],
    waf_managed_rules: managed ?? [],
    redirect_rules: redirects ?? [],
    worker_routes: routes,
    dnssec: { status: dnssec.status, ds: dnssec.ds ?? null },
    settings: { security_header: stable(hsts.value) },
    bot_management: stable(
      Object.fromEntries(Object.entries(bots).filter(([key]) => !BOT_TRANSIENT.has(key))),
    ),
  };
}

export function fileFor(zone: string): string {
  return resolve(OUTPUT_DIR, `${zone}.json`);
}

export function render(data: ZoneExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Line-level diff, enough to show which record or rule moved. */
function diffLines(expected: string, actual: string): string[] {
  const want = expected.split('\n');
  const have = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(want.length, have.length);
  for (let i = 0; i < max; i += 1) {
    if (want[i] !== have[i]) {
      if (want[i] !== undefined) out.push(`- ${want[i] ?? ''}`);
      if (have[i] !== undefined) out.push(`+ ${have[i] ?? ''}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  let drift = 0;

  for (const zone of ZONES) {
    const live = render(await exportZone(zone));
    const file = fileFor(zone.name);
    if (!check) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(file, live);
      console.log(`wrote ${file}`);
      continue;
    }
    let committed = '';
    try {
      committed = readFileSync(file, 'utf8');
    } catch {
      // missing file: reported as drift below
    }
    if (committed === live) {
      console.log(`${zone.name}: matches infra/cloudflare/${zone.name}.json`);
    } else {
      drift += 1;
      console.error(
        `${zone.name}: live edge config differs from infra/cloudflare/${zone.name}.json`,
      );
      for (const line of diffLines(committed, live).slice(0, 80)) console.error(line);
    }
  }

  if (drift > 0) {
    console.error(
      `${String(drift)} zone(s) drifted. Revert the dashboard change, or run \`pnpm edge-config:export\` and commit the new state on purpose.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
