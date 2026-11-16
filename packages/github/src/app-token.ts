import { createPrivateKey, sign } from 'node:crypto';

/**
 * GitHub App identity for the hub (P2-03).
 *
 * One App, `the40thieves-bot`, is the only non-human identity that talks to GitHub on the
 * hub's behalf: the build-time content loader (P2-04), the rebuild dispatch (P2-09) and the
 * org README commit (P2-10). Everything here runs on `node:crypto` and `fetch`, so it works
 * under Node in CI and under `nodejs_compat` in a Worker.
 *
 * Secrets never leave the caller: this module takes the App ID and the PEM private key as
 * values, signs with them, and returns tokens; it logs nothing.
 */

export const GITHUB_API = 'https://api.github.com';

/** Installation tokens live one hour; refresh after fifty minutes (P2-03). */
export const INSTALLATION_TOKEN_TTL_MS = 50 * 60 * 1000;

/** An App JWT may be at most ten minutes long; nine leaves room for clock skew. */
const APP_JWT_LIFETIME_S = 9 * 60;
/** Issue the JWT a minute in the past so a fast clock on our side is still accepted. */
const APP_JWT_BACKDATE_S = 60;

const USER_AGENT = 'the40thieves-hub (https://the40thieves.dev)';
const API_VERSION = '2022-11-28';

export interface AppCredentials {
  /** The App ID shown on the App's settings page (not secret). */
  appId: string | number;
  /** The PEM private key generated on the App's settings page. */
  privateKey: string;
}

/**
 * Narrows an installation token below the installation's own grant; GitHub refuses anything
 * above it. `repositories` are names without the owner.
 */
export interface TokenScope {
  repositories?: string[];
  permissions?: Record<string, 'read' | 'write'>;
}

export interface InstallationToken {
  token: string;
  /** ISO timestamp from GitHub; one hour after minting. */
  expiresAt: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Clock {
  now: () => number;
}

const systemClock: Clock = { now: () => Date.now() };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A signed App JWT (RS256) that authenticates as the App itself, for the handful of
 * endpoints that take one: listing installations and minting installation tokens.
 */
export function appJwt(credentials: AppCredentials, clock: Clock = systemClock): string {
  const nowS = Math.floor(clock.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowS - APP_JWT_BACKDATE_S,
      exp: nowS - APP_JWT_BACKDATE_S + APP_JWT_LIFETIME_S,
      iss: String(credentials.appId),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(credentials.privateKey);
  const signature = sign('sha256', Buffer.from(signingInput), key);
  return `${signingInput}.${base64url(signature)}`;
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

/** The error carries the status and the endpoint, never the response body or any token. */
class GitHubAppError extends Error {
  readonly status: number;

  constructor(status: number, endpoint: string) {
    super(`GitHub App request failed: ${String(status)} ${endpoint}`);
    this.name = 'GitHubAppError';
    this.status = status;
  }
}

/**
 * The installation ID for one account (org or user) the App is installed on. Lets the
 * callers store only the App ID and key; the installation is discovered, not configured.
 */
export async function findInstallationId(
  credentials: AppCredentials,
  accountLogin: string,
  fetchImpl: FetchLike = fetch,
  clock: Clock = systemClock,
): Promise<number> {
  const endpoint = '/app/installations?per_page=100';
  const response = await fetchImpl(`${GITHUB_API}${endpoint}`, {
    headers: appHeaders(appJwt(credentials, clock)),
  });
  if (!response.ok) throw new GitHubAppError(response.status, endpoint);
  const installations = (await response.json()) as { id: number; account: { login: string } }[];
  const match = installations.find(
    (installation) => installation.account.login.toLowerCase() === accountLogin.toLowerCase(),
  );
  if (!match) throw new Error(`GitHub App is not installed on ${accountLogin}`);
  return match.id;
}

/** Exchange an App JWT for a one-hour installation token. */
export async function mintInstallationToken(
  credentials: AppCredentials,
  installationId: number,
  fetchImpl: FetchLike = fetch,
  clock: Clock = systemClock,
  scope?: TokenScope,
): Promise<InstallationToken> {
  const endpoint = `/app/installations/${String(installationId)}/access_tokens`;
  const headers = appHeaders(appJwt(credentials, clock));
  const response = await fetchImpl(`${GITHUB_API}${endpoint}`, {
    method: 'POST',
    headers: scope ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: scope ? JSON.stringify(scope) : undefined,
  });
  if (response.status !== 201) throw new GitHubAppError(response.status, endpoint);
  const body = (await response.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
}

export interface InstallationTokenProvider {
  /** A valid installation token, minted on first use and reused for fifty minutes. */
  get: () => Promise<string>;
  /** Drop the cached token, for example after a 401. */
  invalidate: () => void;
}

export interface ProviderOptions {
  credentials: AppCredentials;
  installationId: number;
  fetchImpl?: FetchLike;
  clock?: Clock;
  /** Refresh interval; defaults to fifty minutes and never exceeds GitHub's own expiry. */
  ttlMs?: number;
  /** Applied to every mint; a long-lived holder (a Worker) should carry the narrowest grant. */
  scope?: TokenScope;
}

/**
 * Caches one installation token per provider. Concurrent callers share a single mint, so a
 * burst of requests at startup costs one token exchange, not one per caller.
 */
export function createInstallationTokenProvider(
  options: ProviderOptions,
): InstallationTokenProvider {
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? INSTALLATION_TOKEN_TTL_MS;
  let cached: { token: string; refreshAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const minted = await mintInstallationToken(
      options.credentials,
      options.installationId,
      options.fetchImpl,
      clock,
      options.scope,
    );
    const now = clock.now();
    // A minute before GitHub's expiry, or the configured interval, whichever comes first.
    const githubRefreshAt = Date.parse(minted.expiresAt) - 60 * 1000;
    const refreshAt = Math.min(
      now + ttlMs,
      Number.isNaN(githubRefreshAt) ? Infinity : githubRefreshAt,
    );
    cached = { token: minted.token, refreshAt };
    return minted.token;
  };

  return {
    async get() {
      if (cached && clock.now() < cached.refreshAt) return cached.token;
      inFlight ??= mint().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
