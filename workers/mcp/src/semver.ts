export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, numeric ones as numbers; empty for a release. */
  pre: (string | number)[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `v?MAJOR.MINOR.PATCH(-pre)?(+build)?` as release tags carry it, or null. */
export function parseVersion(input: string): Version | null {
  const match = SEMVER.exec(input);
  if (!match) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: pre.map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

function comparePre(a: (string | number)[], b: (string | number)[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Semver precedence of two tags; null when either is not semver. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}
