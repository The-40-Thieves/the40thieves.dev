/**
 * One structured line per request. It never carries a URL, path, query string, header value,
 * session token, Turnstile token or client IP: `host` is the allowlisted upstream hostname only.
 */
export interface LogEntry {
  route: 'fetch' | 'quota' | 'session' | 'other';
  /** `complete`, `too_large`, `timeout` or `failed` for a relayed body; otherwise a fixed word or error code. */
  outcome: string;
  status: number;
  host?: string;
  /** Response body bytes passed on to the client. */
  bytes?: number;
  ms: number;
}

/** The only console call in the relay. */
export function writeLog(entry: LogEntry): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
}
