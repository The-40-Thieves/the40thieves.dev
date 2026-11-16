import { expect, test } from 'vitest';

import sources from '../../../data/sources.json' with { type: 'json' };
import { RELAY_HOSTS } from '../src/allowlist.ts';
import {
  memoryQuotaStore,
  MemoryCounterTable,
  parseOperatorKeys,
  QUOTA_SOURCES,
  quotaSources,
  reserve,
  secondsToReset,
  SITE_KEY,
  utcDay,
  visitorKey,
} from '../src/quota.ts';

test('the quota table is exactly the quota-relay entries of data/sources.json', () => {
  const entries = sources.sources.filter((s) => s.route === 'quota-relay');
  expect([...QUOTA_SOURCES.keys()].sort()).toEqual(entries.map((s) => s.name).sort());
  for (const entry of entries) {
    const source = QUOTA_SOURCES.get(entry.name);
    expect(source?.host).toBe(entry.hosts[0]);
    expect(source?.siteCap).toBe(Math.floor((entry.key?.daily_cap ?? 0) * 0.8));
    expect(source?.visitorCap).toBeLessThan(source?.siteCap ?? 0);
  }
});

test('the site caps are 80% of the upstream caps', () => {
  expect(
    Object.fromEntries([...QUOTA_SOURCES].map(([name, source]) => [name, source.siteCap])),
  ).toEqual({ courtlistener: 100, guardian: 360, ucdp: 3600 });
});

test('no quota host is reachable through /v1/fetch', () => {
  for (const source of QUOTA_SOURCES.values()) expect(RELAY_HOSTS.has(source.host)).toBe(false);
});

test('a quota-relay entry without a key placement fails at load', () => {
  expect(() =>
    quotaSources({
      sources: [
        { name: 'new', route: 'quota-relay', hosts: ['a.example'], key: { daily_cap: 10 } },
      ],
    }),
  ).toThrow(/new/);
});

test('operator keys keep known sources with non-empty strings only', () => {
  expect([...parseOperatorKeys('{"guardian":"g","ucdp":"","nope":"x","courtlistener":7}')]).toEqual(
    [['guardian', 'g']],
  );
  for (const raw of [undefined, '', 'not json', '[]', 'null', '"s"']) {
    expect(parseOperatorKeys(raw).size).toBe(0);
  }
});

test('days are UTC and the reset is the next UTC midnight', () => {
  const now = Date.UTC(2026, 10, 14, 23, 59, 30);
  expect(utcDay(now)).toBe('2026-11-14');
  expect(secondsToReset(now)).toBe(30);
  expect(secondsToReset(Date.UTC(2026, 10, 15))).toBe(86_400);
});

test('visitor keys are stable within a day, differ across days and IPs, and hide the IP', async () => {
  const a = await visitorKey('secret', '2026-11-14', '203.0.113.7');
  expect(a).toMatch(/^[0-9a-f]{24}$/);
  expect(await visitorKey('secret', '2026-11-14', '203.0.113.7')).toBe(a);
  expect(await visitorKey('secret', '2026-11-15', '203.0.113.7')).not.toBe(a);
  expect(await visitorKey('secret', '2026-11-14', '203.0.113.8')).not.toBe(a);
  expect(await visitorKey('other', '2026-11-14', '203.0.113.7')).not.toBe(a);
});

test('cap enforcement: the visitor cap, then the site cap, and a refusal spends nothing', () => {
  const table = new MemoryCounterTable();
  const caps = { day: '2026-11-14', siteCap: 5, visitorCap: 3 };
  const results = Array.from({ length: 4 }, () => reserve(table, { ...caps, visitor: 'a' }));
  expect(results.map((r) => (r.ok ? r.remaining : r.scope))).toEqual([2, 1, 0, 'visitor']);
  expect(table.get('2026-11-14', 'a')).toBe(3);
  expect(reserve(table, { ...caps, visitor: 'b' })).toEqual({ ok: true, remaining: 1 });
  expect(reserve(table, { ...caps, visitor: 'b' })).toEqual({ ok: true, remaining: 0 });
  expect(reserve(table, { ...caps, visitor: 'c' })).toEqual({ ok: false, scope: 'site' });
  expect(table.get('2026-11-14', SITE_KEY)).toBe(5);
  expect(table.get('2026-11-14', 'c')).toBe(0);
});

test('a new day starts from zero and drops the old rows', () => {
  const table = new MemoryCounterTable();
  const caps = { siteCap: 1, visitorCap: 1, visitor: 'a' };
  expect(reserve(table, { ...caps, day: '2026-11-14' }).ok).toBe(true);
  expect(reserve(table, { ...caps, day: '2026-11-14' }).ok).toBe(false);
  expect(reserve(table, { ...caps, day: '2026-11-15' }).ok).toBe(true);
  expect([...table.rows.keys()].every((row) => row.startsWith('2026-11-15|'))).toBe(true);
});

test('the memory store keeps one table per source', async () => {
  const store = memoryQuotaStore();
  const input = { day: '2026-11-14', visitor: 'a', siteCap: 1, visitorCap: 1 };
  expect((await store('guardian', input)).ok).toBe(true);
  expect((await store('ucdp', input)).ok).toBe(true);
  expect((await store('guardian', input)).ok).toBe(false);
  expect([...store.tables.keys()]).toEqual(['guardian', 'ucdp']);
});
