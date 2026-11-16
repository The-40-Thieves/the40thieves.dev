/** The Rate Limiting binding's shape; the fake in the tests counts exactly. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Mirrors `ratelimits[].simple` in wrangler.jsonc: 100 requests per IP per period. */
export const RATE_LIMIT_PER_PERIOD = 100;
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The limiter key for a request: the client IP Cloudflare attaches, or "unknown" when the
 * header is absent (a direct call in tests or a misrouted request). The absent case shares
 * one budget rather than bypassing the limiter.
 */
export function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** True when this request is over the budget for its key. */
export async function overLimit(limiter: Limiter, request: Request): Promise<boolean> {
  const { success } = await limiter.limit({ key: clientKey(request) });
  return !success;
}
