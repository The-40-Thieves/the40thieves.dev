/**
 * CSP violation reports (P2-02). Browsers deliver them in two shapes: the legacy
 * `report-uri` POST (`application/csp-report`, one report under "csp-report", kebab-case keys)
 * and the Reporting API batch (`application/reports+json`, an array of typed reports, camelCase
 * keys). Both reduce to the few fields that identify a violation; the original policy is ours
 * and is left out.
 */

/** Largest body the sink reads; a real report is a few hundred bytes. */
export const MAX_CSP_REPORT_BYTES = 16 * 1024;

/** Longest string kept per field, so a hostile report cannot bloat the logs. */
const MAX_FIELD = 256;

export interface CspViolation {
  documentUrl?: string;
  effectiveDirective?: string;
  blockedUrl?: string;
  disposition?: string;
  sourceFile?: string;
  lineNumber?: number;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(raw: Raw, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value !== '') return value.slice(0, MAX_FIELD);
  }
  return undefined;
}

function integer(raw: Raw, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

/** Map one report body (either key style) to a violation, dropping absent fields. */
function violation(raw: Raw): CspViolation {
  const out: CspViolation = {};
  const documentUrl = text(raw, 'documentURL', 'document-uri');
  const effectiveDirective = text(
    raw,
    'effectiveDirective',
    'effective-directive',
    'violated-directive',
  );
  const blockedUrl = text(raw, 'blockedURL', 'blocked-uri');
  const disposition = text(raw, 'disposition');
  const sourceFile = text(raw, 'sourceFile', 'source-file');
  const lineNumber = integer(raw, 'lineNumber', 'line-number');
  if (documentUrl !== undefined) out.documentUrl = documentUrl;
  if (effectiveDirective !== undefined) out.effectiveDirective = effectiveDirective;
  if (blockedUrl !== undefined) out.blockedUrl = blockedUrl;
  if (disposition !== undefined) out.disposition = disposition;
  if (sourceFile !== undefined) out.sourceFile = sourceFile;
  if (lineNumber !== undefined) out.lineNumber = lineNumber;
  return out;
}

/**
 * Parse a report body by its content type. Returns `null` for a content type the sink does not
 * accept, for a body that is not JSON, or for JSON of the wrong shape; otherwise the violations
 * it carried (possibly none, when a Reporting API batch held only other report types).
 */
export function parseCspReports(contentType: string | null, body: string): CspViolation[] | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/csp-report' && type !== 'application/reports+json') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (type === 'application/csp-report') {
    if (!isRecord(parsed) || !isRecord(parsed['csp-report'])) return null;
    return [violation(parsed['csp-report'])];
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((entry): entry is Raw => isRecord(entry) && entry['type'] === 'csp-violation')
    .map((entry) => violation(isRecord(entry['body']) ? entry['body'] : {}));
}
