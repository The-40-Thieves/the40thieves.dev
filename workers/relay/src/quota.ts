import sources from '../../../data/sources.json' with { type: 'json' };

/**
 * The quota relay (P4-S3): keyed sources the relay calls with the operator's own key, under
 * a daily budget. Upstream caps come from `data/sources.json`; how each source takes its key does
 * not live there, so it is the table below, and a quota-relay entry without a row fails at load.
 */

/** How a source takes its key: a header (with an optional value prefix) or a query parameter. */
export type KeyPlacement =
  { in: 'header'; name: string; prefix: string } | { in: 'query'; name: string };

interface SourceAuth {
  key: KeyPlacement;
  /** Relayed requests one visitor may spend on this source per UTC day. */
  visitorCap: number;
}

/** Each quota-relay source's key placement (from its API docs) and per-visitor cap. */
const AUTH: Readonly<Record<string, SourceAuth>> = {
  // https://www.courtlistener.com/help/api/rest/#your-authorization-token
  courtlistener: {
    key: { in: 'header', name: 'authorization', prefix: 'Token ' },
    visitorCap: 10,
  },
  // https://open-platform.theguardian.com/documentation/
  guardian: { key: { in: 'query', name: 'api-key' }, visitorCap: 30 },
  // https://ucdp.uu.se/apidocs/
  ucdp: { key: { in: 'header', name: 'x-ucdp-access-token', prefix: '' }, visitorCap: 100 },
};

/** The share of upstream's declared daily cap the site spends; the rest is headroom. */
export const SITE_SHARE = 0.8;

export interface QuotaSource {
  name: string;
  /** The one upstream hostname, lower case. */
  host: string;
  key: KeyPlacement;
  /** Relayed requests for everyone together per UTC day: `floor(daily_cap * SITE_SHARE)`. */
  siteCap: number;
  visitorCap: number;
}

/** The slice of data/sources.json this file reads. */
export interface QuotaSourcesFile {
  sources: {
    name: string;
    route: string;
    hosts: string[];
    key: { daily_cap?: number | null } | null;
  }[];
}

/** The quota-relay entries of `file`, joined with `auth`. Throws on an entry it cannot serve. */
export function quotaSources(
  file: QuotaSourcesFile,
  auth: Readonly<Record<string, SourceAuth>> = AUTH,
): ReadonlyMap<string, QuotaSource> {
  const out = new Map<string, QuotaSource>();
  for (const source of file.sources) {
    if (source.route !== 'quota-relay') continue;
    const row = auth[source.name];
    const dailyCap = source.key?.daily_cap;
    if (row === undefined || typeof dailyCap !== 'number' || source.hosts.length !== 1) {
      throw new Error(`quota relay: no key placement, daily cap or single host for ${source.name}`);
    }
    out.set(source.name, {
      name: source.name,
      host: (source.hosts[0] ?? '').toLowerCase(),
      key: row.key,
      siteCap: Math.floor(dailyCap * SITE_SHARE),
      visitorCap: row.visitorCap,
    });
  }
  return out;
}

/** Built once at module load from the committed file, like the visitor-key allowlist. */
export const QUOTA_SOURCES: ReadonlyMap<string, QuotaSource> = quotaSources(sources);

/**
 * `OPERATOR_KEYS`, a JSON object of source name to key. Only known sources with a non-empty
 * string are kept; anything malformed yields no keys, so those sources answer not_configured.
 */
export function parseOperatorKeys(
  raw: string | undefined,
  known: ReadonlyMap<string, QuotaSource> = QUOTA_SOURCES,
): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  if (raw === undefined || raw.trim() === '') return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return keys;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return keys;
  for (const [name, value] of Object.entries(parsed)) {
    if (known.has(name) && typeof value === 'string' && value !== '') keys.set(name, value);
  }
  return keys;
}

const DAY_MS = 86_400_000;

/** The UTC day of `now`, `YYYY-MM-DD`. Budgets reset at UTC midnight. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole seconds until the next UTC midnight, at least 1: the `Retry-After` of `quota_reached`. */
export function secondsToReset(now: number): number {
  return Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));
}

/**
 * The counter key for one visitor on one day: a truncated HMAC of the day and the client IP,
 * keyed by the relay's secret. No IP is stored, and keys do not link across days.
 */
export async function visitorKey(secret: string, day: string, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`quota:${day}:${ip}`));
  return [...new Uint8Array(mac).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** The site-wide counter's key; visitor keys are hex, so they never collide with it. */
export const SITE_KEY = '*';

export interface ReserveInput {
  day: string;
  visitor: string;
  siteCap: number;
  visitorCap: number;
}

export type ReserveResult =
  { ok: true; remaining: number } | { ok: false; scope: 'site' | 'visitor' };

/** One source's counters for the current day. */
export interface CounterTable {
  get(day: string, key: string): number;
  set(day: string, key: string, count: number): void;
  /** Drop every row from a day before `day`. */
  pruneBefore(day: string): void;
}

/**
 * Spend one request of the site budget and the visitor budget, or neither. Run inside one
 * Durable Object per source, so calls never interleave. `remaining` is what this visitor can
 * still spend today, the smaller of the two budgets.
 */
export function reserve(table: CounterTable, input: ReserveInput): ReserveResult {
  table.pruneBefore(input.day);
  const site = table.get(input.day, SITE_KEY);
  if (site >= input.siteCap) return { ok: false, scope: 'site' };
  const visitor = table.get(input.day, input.visitor);
  if (visitor >= input.visitorCap) return { ok: false, scope: 'visitor' };
  table.set(input.day, SITE_KEY, site + 1);
  table.set(input.day, input.visitor, visitor + 1);
  return {
    ok: true,
    remaining: Math.min(input.siteCap - site - 1, input.visitorCap - visitor - 1),
  };
}

/** Where `reserve` runs: the Durable Object in production, a Map in tests. */
export type QuotaStore = (source: string, input: ReserveInput) => Promise<ReserveResult>;

/** A `CounterTable` over a Map, for tests and the local stack. */
export class MemoryCounterTable implements CounterTable {
  readonly rows = new Map<string, number>();

  get(day: string, key: string): number {
    return this.rows.get(`${day}|${key}`) ?? 0;
  }

  set(day: string, key: string, count: number): void {
    this.rows.set(`${day}|${key}`, count);
  }

  pruneBefore(day: string): void {
    for (const row of [...this.rows.keys()]) {
      if (row.slice(0, row.indexOf('|')) < day) this.rows.delete(row);
    }
  }
}

/** A `QuotaStore` with one `MemoryCounterTable` per source. */
export function memoryQuotaStore(): QuotaStore & { tables: Map<string, MemoryCounterTable> } {
  const tables = new Map<string, MemoryCounterTable>();
  const store = (source: string, input: ReserveInput): Promise<ReserveResult> => {
    let table = tables.get(source);
    if (table === undefined) {
      table = new MemoryCounterTable();
      tables.set(source, table);
    }
    return Promise.resolve(reserve(table, input));
  };
  return Object.assign(store, { tables });
}
