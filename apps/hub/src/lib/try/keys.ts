/**
 * The visitor's keys (P4-S4). By default they live in this module's memory and nowhere
 * else, so a reload forgets them. Only when the visitor ticks "keep for this tab" are they
 * written to sessionStorage, which the browser clears when the tab closes. They never go to
 * localStorage, IndexedDB, OPFS or a cookie.
 */

/** The single sessionStorage entry; present only after an explicit opt-in. */
export const SESSION_KEY = 'alexandria-try:keys';

/** The slice of `Storage` the store uses, so tests can hand in a Map-backed fake. */
export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class KeyStore {
  private readonly keys = new Map<string, string>();
  private persist = false;

  /** `storage` is sessionStorage in the browser, or null where it is blocked. */
  constructor(private readonly storage: KeyStorage | null) {
    const saved = this.read();
    if (saved !== null) {
      this.persist = true;
      for (const [id, value] of Object.entries(saved)) this.keys.set(id, value);
    }
  }

  get persisted(): boolean {
    return this.persist;
  }

  get(id: string): string {
    return this.keys.get(id) ?? '';
  }

  set(id: string, value: string): void {
    const trimmed = value.trim();
    if (trimmed === '') this.keys.delete(id);
    else this.keys.set(id, trimmed);
    this.write();
  }

  /** Turn the tab-scoped copy on or off; off removes it at once. */
  setPersist(on: boolean): void {
    this.persist = on;
    this.write();
  }

  /** Forget every key, in memory and in the tab. */
  clear(): void {
    this.keys.clear();
    this.persist = false;
    this.write();
  }

  private read(): Record<string, string> | null {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
        ),
      );
    } catch {
      return null;
    }
  }

  private write(): void {
    try {
      if (!this.persist) this.storage?.removeItem(SESSION_KEY);
      else this.storage?.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(this.keys)));
    } catch {
      // Storage blocked (private mode, sandboxing): the keys stay in memory only.
    }
  }
}
