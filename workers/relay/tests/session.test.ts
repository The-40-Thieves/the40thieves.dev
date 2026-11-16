import { expect, test } from 'vitest';

import { mintSession, verifySession } from '../src/session.ts';

const SECRET = 'a-test-secret-of-some-length';
const NOW = 1_800_000_000_000;

function signatureOf(session: string): string {
  return session.split('.').slice(2).join('.');
}

test('mintSession returns a v1 token and an expiry one hour out', async () => {
  const { session, expires_at } = await mintSession(SECRET, NOW);
  expect(expires_at).toBe(Math.floor(NOW / 1000) + 3600);
  const parts = session.split('.');
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe('v1');
  expect(parts[1]).toBe(String(expires_at));
  expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('expires_at floors the millisecond clock', async () => {
  const { expires_at } = await mintSession(SECRET, NOW + 999);
  expect(expires_at).toBe(Math.floor(NOW / 1000) + 3600);
});

test('a minted token verifies ok at now and at now + 3_599_000', async () => {
  const { session } = await mintSession(SECRET, NOW);
  expect(await verifySession(SECRET, session, NOW)).toBe('ok');
  expect(await verifySession(SECRET, session, NOW + 3_599_000)).toBe('ok');
});

test('a minted token is invalid at now + 3_600_000', async () => {
  const { session } = await mintSession(SECRET, NOW);
  expect(await verifySession(SECRET, session, NOW + 3_600_000)).toBe('invalid');
});

test('one changed signature character is invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  const [v, exp, sig] = session.split('.') as [string, string, string];
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  expect(await verifySession(SECRET, `${v}.${exp}.${flipped}`, NOW)).toBe('invalid');
});

test('every last-character variant of the signature other than the real one is invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  const real = session.slice(-1);
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    if (c === real) continue;
    expect(await verifySession(SECRET, session.slice(0, -1) + c, NOW)).toBe('invalid');
  }
});

test('exp raised by one is invalid', async () => {
  const { session, expires_at } = await mintSession(SECRET, NOW);
  const sig = signatureOf(session);
  expect(await verifySession(SECRET, `v1.${String(expires_at + 1)}.${sig}`, NOW)).toBe('invalid');
});

test('a different secret is invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  expect(await verifySession('another-secret', session, NOW)).toBe('invalid');
});

test('two and four dot-separated parts are invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  const [v, exp, sig] = session.split('.') as [string, string, string];
  expect(await verifySession(SECRET, `${v}.${exp}`, NOW)).toBe('invalid');
  expect(await verifySession(SECRET, `${v}.${exp}.${sig}.x`, NOW)).toBe('invalid');
});

test('a wrong version is invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  expect(await verifySession(SECRET, session.replace(/^v1/, 'v2'), NOW)).toBe('invalid');
});

test.each(['', 'abc', '1e9', '-5', '1234567890123', ' 123', '12 3', '+12', '1.5'])(
  'an exp of %j is invalid',
  async (exp) => {
    const { session } = await mintSession(SECRET, NOW);
    const sig = signatureOf(session);
    expect(await verifySession(SECRET, `v1.${exp}.${sig}`, NOW)).toBe('invalid');
  },
);

test.each(['', '!!!', 'a', 'AAAA====', 'not base64url+/', '%%%%', 'éé'])(
  'a signature of %j is invalid and never throws',
  async (sig) => {
    const { expires_at } = await mintSession(SECRET, NOW);
    expect(await verifySession(SECRET, `v1.${String(expires_at)}.${sig}`, NOW)).toBe('invalid');
  },
);

test('a signature of the wrong length is invalid', async () => {
  const { session } = await mintSession(SECRET, NOW);
  const [v, exp, sig] = session.split('.') as [string, string, string];
  expect(await verifySession(SECRET, `${v}.${exp}.${sig.slice(0, -4)}`, NOW)).toBe('invalid');
});

test('null and the empty string are missing', async () => {
  expect(await verifySession(SECRET, null, NOW)).toBe('missing');
  expect(await verifySession(SECRET, '', NOW)).toBe('missing');
});

test('two mints at the same second are equal and verify', async () => {
  const a = await mintSession(SECRET, NOW);
  const b = await mintSession(SECRET, NOW + 500);
  expect(a).toEqual(b);
});
