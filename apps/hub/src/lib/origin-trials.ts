import trials from '../../../../security/origin-trials.json' with { type: 'json' };

/**
 * Origin Trial tokens (O-13, P3-S4). A token is public: it only works on the origin it was
 * issued for, and the browser reads it from a `<meta http-equiv="origin-trial">`. The layout
 * prints the tokens that are for this origin and still valid, so a trial that ends switches its
 * feature off at the next build instead of leaving a dead tag behind.
 */
export interface TrialEntry {
  /** Which browser's trial issued the token: `chrome` or `edge`. A label for people only. */
  browser: string;
  token: string;
}

/** The committed tokens, as `security/origin-trials.json` lists them. */
export const TRIAL_ENTRIES: readonly TrialEntry[] = trials.tokens;

/** The origin as trial tokens spell it: scheme, host and port. */
export const SITE_TRIAL_ORIGIN = 'https://the40thieves.dev:443';

export interface TrialToken {
  origin: string;
  feature: string;
  /** Seconds since the epoch. */
  expiry: number;
  isSubdomain: boolean;
}

const SIGNATURE_BYTES = 64;
/** Version byte, signature, then a big-endian payload length. */
const HEADER_BYTES = 1 + SIGNATURE_BYTES + 4;

/**
 * The payload of a Chromium-format trial token (Edge uses the same format): base64 of a version
 * byte (2 or 3), a 64 byte signature, a 32 bit payload length and a JSON payload. The signature
 * is not checked here; the browser does that. Throws on anything malformed.
 */
export function decodeTrialToken(token: string): TrialToken {
  const bytes = Uint8Array.from(atob(token), (char) => char.charCodeAt(0));
  if (bytes.length < HEADER_BYTES) throw new Error('origin trial token is too short');
  const version = bytes[0];
  if (version !== 2 && version !== 3) {
    throw new Error(`origin trial token has unknown version ${String(version)}`);
  }
  const length = new DataView(bytes.buffer).getUint32(1 + SIGNATURE_BYTES);
  if (length !== bytes.length - HEADER_BYTES) {
    throw new Error('origin trial token payload length does not match');
  }
  const payload: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES)),
  );
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('origin trial token payload is not an object');
  }
  const { origin, feature, expiry, isSubdomain } = payload as Record<string, unknown>;
  if (typeof origin !== 'string' || typeof feature !== 'string') {
    throw new Error('origin trial token names no origin or feature');
  }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
    throw new Error('origin trial token has no expiry');
  }
  return { origin, feature, expiry, isSubdomain: isSubdomain === true };
}

/** The tokens worth printing at `nowMs`: well formed, for this origin and not yet expired. */
export function activeTrialTokens(tokens: readonly string[], nowMs: number): string[] {
  return tokens.filter((token) => {
    try {
      const { origin, expiry } = decodeTrialToken(token);
      return origin === SITE_TRIAL_ORIGIN && expiry * 1000 > nowMs;
    } catch {
      return false;
    }
  });
}
