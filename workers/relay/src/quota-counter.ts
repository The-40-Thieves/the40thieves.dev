import { reserve, type CounterTable, type ReserveInput } from './quota.ts';

/**
 * The quota relay's counters (P4-S3): one SQLite-backed Durable Object per source, named by
 * the source, so every reservation for a source runs in one place, one at a time, and the count
 * is exact. Called with `fetch` and a JSON body (no `cloudflare:workers` import, so the entry
 * module still loads under node for the tests).
 */
export class QuotaCounter {
  private readonly table: CounterTable;

  constructor(state: DurableObjectState) {
    const { sql } = state.storage;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))',
    );
    this.table = {
      get(day, key) {
        const row = sql
          .exec<{ n: number }>('SELECT n FROM counts WHERE day = ? AND key = ?', day, key)
          .toArray()[0];
        return row?.n ?? 0;
      },
      set(day, key, count) {
        sql.exec(
          'INSERT INTO counts (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = excluded.n',
          day,
          key,
          count,
        );
      },
      pruneBefore(day) {
        sql.exec('DELETE FROM counts WHERE day < ?', day);
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const input = await request.json<ReserveInput>();
    return Response.json(reserve(this.table, input));
  }
}
