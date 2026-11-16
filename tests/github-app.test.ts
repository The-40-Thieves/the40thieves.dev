import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  appJwt,
  createInstallationTokenProvider,
  findInstallationId,
  INSTALLATION_TOKEN_TTL_MS,
  mintInstallationToken,
} from '@the40thieves/github';

// GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY") PEMs; generate the same shape here.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const credentials = { appId: 5593745, privateKey };

const fixedNow = Date.parse('2026-11-03T12:00:00.000Z');
const clockAt = (ms: number) => ({ now: () => ms });

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('appJwt', () => {
  test('is an RS256 JWT issued by the App ID, backdated a minute and valid for nine', () => {
    const jwt = appJwt(credentials, clockAt(fixedNow));
    const [header, payload, signature] = jwt.split('.');
    expect(header && payload && signature).toBeTruthy();
    expect(decode(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload ?? '');
    const nowS = Math.floor(fixedNow / 1000);
    expect(claims).toEqual({ iat: nowS - 60, exp: nowS - 60 + 9 * 60, iss: '5593745' });
    // Ten minutes is GitHub's ceiling; stay under it even with the backdate.
    expect(Number(claims['exp']) - nowS).toBeLessThanOrEqual(10 * 60);
    const ok = verify(
      'sha256',
      Buffer.from(`${header ?? ''}.${payload ?? ''}`),
      createPublicKey(publicKey),
      Buffer.from(signature ?? '', 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

type Call = {
  url: string;
  method: string;
  authorization: string | undefined;
  body: string | undefined;
};

/** A fetch double that records calls and answers from a script keyed by URL path. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const path = new URL(input).pathname + new URL(input).search;
    const route = routes[path];
    if (!route) throw new Error(`unexpected request ${path}`);
    return Promise.resolve(route());
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('findInstallationId', () => {
  test('returns the installation on the named account, case-insensitively', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/app/installations?per_page=100': () =>
        json(200, [
          { id: 1, account: { login: 'someone-else' } },
          { id: 178154584, account: { login: 'The-40-Thieves' } },
        ]),
    });
    await expect(findInstallationId(credentials, 'the-40-thieves', fetchImpl)).resolves.toBe(
      178154584,
    );
    expect(calls[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('fails plainly when the App is not installed there', async () => {
    const { fetchImpl } = fakeFetch({ '/app/installations?per_page=100': () => json(200, []) });
    await expect(findInstallationId(credentials, 'nobody', fetchImpl)).rejects.toThrow(
      'not installed on nobody',
    );
  });
});

describe('mintInstallationToken', () => {
  test('posts an App JWT and returns the token with its expiry', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/app/installations/178154584/access_tokens': () =>
        json(201, { token: 'ghs_fake', expires_at: '2026-11-03T13:00:00Z' }),
    });
    const minted = await mintInstallationToken(credentials, 178154584, fetchImpl);
    expect(minted).toEqual({ token: 'ghs_fake', expiresAt: '2026-11-03T13:00:00Z' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBeUndefined();
  });

  test('a scope narrows the token to the named repositories and permissions', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/app/installations/178154584/access_tokens': () =>
        json(201, { token: 'ghs_narrow', expires_at: '2026-11-03T13:00:00Z' }),
    });
    const scope = {
      repositories: ['the40thieves.dev'],
      permissions: { contents: 'write' as const },
    };
    await mintInstallationToken(credentials, 178154584, fetchImpl, undefined, scope);
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual(scope);
  });

  test('a provider built with a scope mints every token narrowed to it', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/app/installations/178154584/access_tokens': () =>
        json(201, { token: 'ghs_narrow', expires_at: '2026-11-03T13:00:00Z' }),
    });
    const scope = {
      repositories: ['the40thieves.dev'],
      permissions: { contents: 'write' as const },
    };
    const provider = createInstallationTokenProvider({
      credentials,
      installationId: 178154584,
      fetchImpl,
      clock: clockAt(fixedNow),
      scope,
    });
    expect(await provider.get()).toBe('ghs_narrow');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual(scope);
  });

  test('reports the status and endpoint on failure, never the body', async () => {
    const { fetchImpl } = fakeFetch({
      '/app/installations/1/access_tokens': () => json(401, { message: 'Bad credentials' }),
    });
    await expect(mintInstallationToken(credentials, 1, fetchImpl)).rejects.toThrow(
      'GitHub App request failed: 401 /app/installations/1/access_tokens',
    );
  });
});

describe('createInstallationTokenProvider', () => {
  function providerWithClock() {
    let now = fixedNow;
    let minted = 0;
    const { fetchImpl, calls } = fakeFetch({
      '/app/installations/178154584/access_tokens': () => {
        minted += 1;
        return json(201, {
          token: `ghs_${String(minted)}`,
          expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        });
      },
    });
    const provider = createInstallationTokenProvider({
      credentials,
      installationId: 178154584,
      fetchImpl,
      clock: { now: () => now },
    });
    return { provider, calls, advance: (ms: number) => (now += ms) };
  }

  test('mints once and reuses the token until fifty minutes have passed', async () => {
    const { provider, calls, advance } = providerWithClock();
    await expect(provider.get()).resolves.toBe('ghs_1');
    advance(INSTALLATION_TOKEN_TTL_MS - 1000);
    await expect(provider.get()).resolves.toBe('ghs_1');
    advance(2000);
    await expect(provider.get()).resolves.toBe('ghs_2');
    expect(calls).toHaveLength(2);
  });

  test('concurrent first callers share one mint', async () => {
    const { provider, calls } = providerWithClock();
    const tokens = await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(tokens).toEqual(['ghs_1', 'ghs_1', 'ghs_1']);
    expect(calls).toHaveLength(1);
  });

  test('invalidate forces a fresh mint', async () => {
    const { provider, calls } = providerWithClock();
    await provider.get();
    provider.invalidate();
    await expect(provider.get()).resolves.toBe('ghs_2');
    expect(calls).toHaveLength(2);
  });
});
