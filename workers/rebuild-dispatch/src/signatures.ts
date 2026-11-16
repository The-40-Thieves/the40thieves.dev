/**
 * Webhook signature schemes, implemented on WebCrypto so the same code runs under workerd and in
 * the Node test runner.
 *
 * - GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`.
 * - Sanity: `sanity-webhook-signature: t=<unix ms>,v1=<base64url HMAC-SHA256 of "<ms>.<body>">`,
 *   the scheme `@sanity/webhook` implements; this Worker adds the five-minute window the
 *   toolkit leaves to the caller.
 */

/** How far a Sanity delivery's timestamp may sit from the Worker's clock, either way. */
export const SANITY_WINDOW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Compares two byte strings in time that depends only on their length. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Produces the `X-Hub-Signature-256` header GitHub would send for `body`. */
export async function signGitHub(secret: string, body: string): Promise<string> {
  return `sha256=${toHex(await hmacSha256(secret, body))}`;
}

export async function verifyGitHubSignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (header === null || !header.startsWith('sha256=')) return false;
  const given = fromHex(header.slice('sha256='.length));
  if (given === null) return false;
  return timingSafeEqual(given, await hmacSha256(secret, body));
}

/** Produces the `sanity-webhook-signature` header Sanity would send for `body` at `timestamp`. */
export async function signSanity(secret: string, body: string, timestamp: number): Promise<string> {
  const signature = toBase64Url(await hmacSha256(secret, `${String(timestamp)}.${body}`));
  return `t=${String(timestamp)},v1=${signature}`;
}

export type SanityVerification =
  { ok: true } | { ok: false; reason: 'malformed' | 'invalid' | 'stale' };

const SANITY_HEADER = /^t=(\d+)[, ]+v1=([^, ]+)$/;

/**
 * Checks the signature first, then the timestamp, so "stale" is only ever said about a delivery
 * that Sanity really signed.
 */
export async function verifySanitySignature(
  secret: string,
  body: string,
  header: string | null,
  now: number,
): Promise<SanityVerification> {
  const match = header === null ? null : SANITY_HEADER.exec(header);
  if (match === null) return { ok: false, reason: 'malformed' };
  const timestamp = Number(match[1]);
  const given = fromBase64Url(match[2] ?? '');
  if (!Number.isSafeInteger(timestamp) || given === null) return { ok: false, reason: 'malformed' };
  const expected = await hmacSha256(secret, `${String(timestamp)}.${body}`);
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  if (Math.abs(now - timestamp) > SANITY_WINDOW_MS) return { ok: false, reason: 'stale' };
  return { ok: true };
}
