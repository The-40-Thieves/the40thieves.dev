import { isPublicAddress } from './address.ts';

/** Decides whether a host may be dialled: `ok: true` only when every address it resolves to is public. */
export type Resolver = (host: string) => Promise<{ ok: true } | { ok: false }>;

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5_000;
const VERDICT_TTL_MS = 300_000;
const FAILED_LOOKUP_TTL_MS = 30_000;

const TYPE_A = 1;
const TYPE_AAAA = 28;

interface Verdict {
  ok: boolean;
  /** How long this verdict may be reused. */
  ttlMs: number;
}

/** The address records of one DoH answer, or null when the lookup failed in any way. */
async function lookup(
  fetchFn: typeof fetch,
  host: string,
  type: 'A' | 'AAAA',
): Promise<string[] | null> {
  try {
    const url = `${DOH_URL}?${new URLSearchParams({ name: host, type }).toString()}`;
    const response = await fetchFn(url, {
      headers: { accept: 'application/dns-json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const answer: unknown = await response.json();
    if (typeof answer !== 'object' || answer === null) return null;
    const { Status, Answer } = answer as { Status?: unknown; Answer?: unknown };
    if (Status !== 0) return null;
    if (Answer === undefined) return [];
    if (!Array.isArray(Answer)) return null;
    const addresses: string[] = [];
    for (const record of Answer as unknown[]) {
      if (typeof record !== 'object' || record === null) return null;
      const { type: recordType, data } = record as { type?: unknown; data?: unknown };
      if (typeof recordType !== 'number' || typeof data !== 'string') return null;
      // CNAME and every other record type are not addresses; only A and AAAA are judged.
      if (recordType === TYPE_A || recordType === TYPE_AAAA) addresses.push(data);
    }
    return addresses;
  } catch {
    return null;
  }
}

async function judge(fetchFn: typeof fetch, host: string): Promise<Verdict> {
  const [a, aaaa] = await Promise.all([lookup(fetchFn, host, 'A'), lookup(fetchFn, host, 'AAAA')]);
  if (a === null || aaaa === null) return { ok: false, ttlMs: FAILED_LOOKUP_TTL_MS };
  const addresses = [...a, ...aaaa];
  if (addresses.length === 0) return { ok: false, ttlMs: FAILED_LOOKUP_TTL_MS };
  if (!addresses.every(isPublicAddress)) return { ok: false, ttlMs: VERDICT_TTL_MS };
  return { ok: true, ttlMs: VERDICT_TTL_MS };
}

/**
 * Resolves a host over Cloudflare DNS-over-HTTPS and fails closed: any lookup error, any record that is not a
 * public address, or no address record at all gives `ok: false`. Verdicts are cached per host in the closure
 * (300 s, or 30 s when the lookup failed or returned nothing usable).
 */
export function createDohResolver(deps: { fetch: typeof fetch; now: () => number }): Resolver {
  const cache = new Map<string, { result: { ok: true } | { ok: false }; expiresAt: number }>();
  return async (host) => {
    const key = host.toLowerCase();
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (deps.now() < hit.expiresAt) return hit.result;
      cache.delete(key);
    }
    const verdict = await judge(deps.fetch, key);
    const result = verdict.ok ? ({ ok: true } as const) : ({ ok: false } as const);
    cache.set(key, { result, expiresAt: deps.now() + verdict.ttlMs });
    return result;
  };
}
