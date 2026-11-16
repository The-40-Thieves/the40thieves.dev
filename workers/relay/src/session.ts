/**
 * Signed one-hour session tokens: `v1.<exp seconds>.<base64url HMAC-SHA-256 of "v1.<exp>">`.
 * Stateless: the Worker keeps nothing, the signature is the proof the Turnstile check passed.
 */

const VERSION = 'v1';
const LIFETIME_SECONDS = 3600;
const EXP_PATTERN = /^\d{1,12}$/;

const encoder = new TextEncoder();

function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url without padding, or null. Rejects non-canonical encodings so each signature has one spelling. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

/** Issues a token that expires `LIFETIME_SECONDS` after the second `now` (epoch milliseconds) falls in. */
export async function mintSession(
  secret: string,
  now: number,
): Promise<{ session: string; expires_at: number }> {
  const expires_at = Math.floor(now / 1000) + LIFETIME_SECONDS;
  const payload = `${VERSION}.${String(expires_at)}`;
  const key = await importKey(secret, 'sign');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return { session: `${payload}.${toBase64Url(signature)}`, expires_at };
}

/** `missing` for an absent token, `invalid` for anything malformed, forged or expired. Never throws. */
export async function verifySession(
  secret: string,
  token: string | null,
  now: number,
): Promise<'ok' | 'missing' | 'invalid'> {
  if (token === null || token === '') return 'missing';
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 'invalid';
    const [version, exp, signature] = parts as [string, string, string];
    if (version !== VERSION || !EXP_PATTERN.test(exp)) return 'invalid';
    const signatureBytes = fromBase64Url(signature);
    if (signatureBytes === null) return 'invalid';
    const key = await importKey(secret, 'verify');
    const genuine = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      encoder.encode(`${version}.${exp}`),
    );
    if (!genuine) return 'invalid';
    return Math.floor(now / 1000) < Number(exp) ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
}
