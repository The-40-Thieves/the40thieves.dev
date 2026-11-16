/** Checks a Turnstile widget token with Cloudflare. Resolves false on any failure and never throws. */
export type TurnstileVerifier = (token: string, ip: string | null) => Promise<boolean>;

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export function createTurnstileVerifier(deps: {
  fetch: typeof fetch;
  secret: string;
  /** Hostnames a genuine widget solve may report; the local stack adds `example.com` for the test keys. */
  hostnames: ReadonlySet<string>;
}): TurnstileVerifier {
  return async (token, ip) => {
    if (token === '' || token.length > MAX_TOKEN_LENGTH) return false;
    try {
      const form = new URLSearchParams({ secret: deps.secret, response: token });
      if (ip !== null) form.set('remoteip', ip);
      const response = await deps.fetch(SITEVERIFY_URL, {
        method: 'POST',
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return false;
      }
      const answer: unknown = await response.json();
      if (typeof answer !== 'object' || answer === null) return false;
      const { success, hostname } = answer as { success?: unknown; hostname?: unknown };
      return success === true && typeof hostname === 'string' && deps.hostnames.has(hostname);
    } catch {
      return false;
    }
  };
}
