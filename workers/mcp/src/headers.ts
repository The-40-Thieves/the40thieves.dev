import policy from '../../../security/headers.policy.json' with { type: 'json' };

interface HeaderRule {
  name: string;
  value: string;
  classes: string[];
  path?: string;
}

const MCP_RULES = (policy.headers as HeaderRule[]).filter((rule) => rule.classes.includes('mcp'));

/**
 * The `mcp` route class of `security/headers.policy.json`, bundled into the Worker so the
 * policy stays the single source of truth; the deploy audits the live endpoint against the
 * same file (`audit:headers --class mcp`). These are the unscoped rules: every response
 * carries them.
 */
export const MCP_HEADERS: ReadonlyArray<readonly [string, string]> = MCP_RULES.filter(
  (rule) => rule.path === undefined,
).map((rule) => [rule.name, rule.value] as const);

/** The `mcp` rules the policy scopes to exactly `path` (the server card's CORS and caching). */
export function mcpHeadersFor(path: string): ReadonlyArray<readonly [string, string]> {
  return MCP_RULES.filter((rule) => rule.path === path).map(
    (rule) => [rule.name, rule.value] as const,
  );
}

/** A copy of `response` carrying every `mcp` policy header; the body stream is passed through. */
export function applyMcpHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of MCP_HEADERS) out.headers.set(name, value);
  return out;
}
