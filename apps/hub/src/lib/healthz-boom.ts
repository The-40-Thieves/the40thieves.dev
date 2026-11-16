/**
 * Gate for `/healthz?boom=1` (P2-12): the deliberate error fires only for a request that carries
 * the configured token, so nobody can burn the Sentry error quota from the public route. With
 * no token configured the switch is inert.
 */
export function boomAllowed(provided: string | null, expected: string | undefined): boolean {
  if (expected === undefined || expected === '' || provided === null) return false;
  if (provided.length !== expected.length) return false;
  // Constant time over the full length, so a prefix match reveals nothing through timing.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
