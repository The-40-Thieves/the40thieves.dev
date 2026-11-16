import type { ManifestProject } from '@the40thieves/schemas';

export type ConfigClient = 'cursor' | 'vscode';

export interface Issue {
  /** Dotted path into the config (`mcpServers.codecalc.args[0]`); empty for the whole config. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: Issue[];
  /** The published snippet, parsed, or null when the project publishes none for the client. */
  expected: unknown;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object' && value !== null) return 'an object';
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every place `actual` departs from `expected`. Keys `expected` does not have are not
 * differences (another server beside this one, an `env` block); array elements are compared in
 * full, since an extra argument changes the command.
 */
function diff(expected: unknown, actual: unknown, path: string, issues: Issue[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      issues.push({ path, message: `expected an array, got ${describe(actual)}` });
      return;
    }
    expected.forEach((item, index) => {
      const at = `${path}[${String(index)}]`;
      if (index >= actual.length) {
        issues.push({ path: at, message: `missing; expected ${describe(item)}` });
      } else {
        diff(item, actual[index], at, issues);
      }
    });
    for (let index = expected.length; index < actual.length; index++) {
      issues.push({
        path: `${path}[${String(index)}]`,
        message: `unexpected ${describe(actual[index])}`,
      });
    }
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      issues.push({ path, message: `expected an object, got ${describe(actual)}` });
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (!(key in actual)) {
        issues.push({ path: at, message: `missing; expected ${describe(value)}` });
      } else {
        diff(value, actual[key], at, issues);
      }
    }
    return;
  }
  if (expected !== actual) {
    issues.push({ path, message: `expected ${describe(expected)}, got ${describe(actual)}` });
  }
}

/** Compare a client config against the project's published snippet for that client. */
export function validateConfig(
  project: ManifestProject,
  client: ConfigClient,
  config: string | Record<string, unknown>,
): ValidationResult {
  const snippet = project.install[client];
  if (snippet === null) {
    return {
      valid: false,
      issues: [{ path: '', message: `${project.slug} publishes no ${client} snippet` }],
      expected: null,
    };
  }
  let expected: unknown;
  try {
    expected = JSON.parse(snippet);
  } catch {
    return {
      valid: false,
      issues: [{ path: '', message: `the published ${client} snippet is not JSON` }],
      expected: null,
    };
  }
  let actual: unknown = config;
  if (typeof config === 'string') {
    try {
      actual = JSON.parse(config);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        issues: [{ path: '', message: `config is not JSON: ${reason}` }],
        expected,
      };
    }
  }
  const issues: Issue[] = [];
  diff(expected, actual, '', issues);
  return { valid: issues.length === 0, issues, expected };
}
