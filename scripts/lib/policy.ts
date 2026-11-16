import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root, derived from this file, never from cwd. */
export const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

/**
 * `mcp` is the `/mcp` Worker (P3-S1) and `relay` the relay.the40thieves.dev Worker (P4-S2): each bundles its rules, `gen-headers` never emits them.
 */
export type RouteClass = 'static' | 'ssr' | 'playground' | 'mcp' | 'relay';

export interface HeaderRule {
  name: string;
  value: string;
  classes: RouteClass[];
  /** Cloudflare `_headers` path the rule is scoped to; absent means every path (`/*`). */
  path?: string;
}

export interface Policy {
  version: 1;
  headers: HeaderRule[];
  cspMeta: {
    requiredDirectives: string[];
    forbidden: Record<string, string[]>;
  };
}

/** Every `RouteClass`, for validating the policy file and the `--class` flag. */
export const ROUTE_CLASSES: readonly string[] = ['static', 'ssr', 'playground', 'mcp', 'relay'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isHeaderRule(value: unknown): value is HeaderRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule['name'] === 'string' &&
    typeof rule['value'] === 'string' &&
    isStringArray(rule['classes']) &&
    rule['classes'].every((cls) => ROUTE_CLASSES.includes(cls)) &&
    (rule['path'] === undefined ||
      (typeof rule['path'] === 'string' && rule['path'].startsWith('/')))
  );
}

function isPolicy(value: unknown): value is Policy {
  if (typeof value !== 'object' || value === null) return false;
  const policy = value as Record<string, unknown>;
  if (policy['version'] !== 1) return false;
  if (!Array.isArray(policy['headers']) || !policy['headers'].every(isHeaderRule)) return false;
  const meta = policy['cspMeta'];
  if (typeof meta !== 'object' || meta === null) return false;
  const { requiredDirectives, forbidden } = meta as Record<string, unknown>;
  if (!isStringArray(requiredDirectives)) return false;
  if (typeof forbidden !== 'object' || forbidden === null) return false;
  return Object.values(forbidden).every(isStringArray);
}

const TOKEN = /(\*|:[A-Za-z]\w*)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match `path` against the rule's Cloudflare `_headers` pattern: `*` is one greedy splat,
 * `:name` one path segment (no `/`). Returns the captured values (`splat` for `*`), or null.
 */
export function matchRule(rule: HeaderRule, path: string): Record<string, string> | null {
  const pattern = rule.path ?? '/*';
  const names: string[] = [];
  let source = '^';
  for (const part of pattern.split(TOKEN)) {
    if (part === '') continue;
    if (part === '*') {
      names.push('splat');
      source += '(.*)';
    } else if (part.startsWith(':')) {
      names.push(part.slice(1));
      source += '([^/]+)';
    } else {
      source += escapeRegExp(part);
    }
  }
  const match = new RegExp(`${source}$`).exec(path);
  if (!match) return null;
  const params: Record<string, string> = {};
  names.forEach((name, index) => {
    params[name] = match[index + 1] ?? '';
  });
  return params;
}

/** True when `rule` applies to `path`: unscoped rules everywhere, `/og/*` under `/og/`. */
export function ruleApplies(rule: HeaderRule, path: string): boolean {
  return matchRule(rule, path) !== null;
}

/** The value `rule` yields on `path`, `:name` and `:splat` substituted the way Cloudflare does. */
export function expectedValue(rule: HeaderRule, path: string): string {
  const params = matchRule(rule, path) ?? {};
  return rule.value.replace(/:([A-Za-z]\w*)/g, (token, name: string) => params[name] ?? token);
}

/** Load and validate the header policy. `path` is relative to the repo root unless absolute. */
export function loadPolicy(path = 'security/headers.policy.json'): Policy {
  const file = resolve(repoRoot, path);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isPolicy(parsed)) {
    throw new Error(`Invalid header policy: ${file}`);
  }
  return parsed;
}
