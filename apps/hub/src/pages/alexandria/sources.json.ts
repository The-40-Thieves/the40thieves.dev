import { sourcesFile } from '../../lib/sources.ts';

/**
 * `/alexandria/sources.json`: the routing matrix as data (P4-S1), the same file the repo
 * commits at `data/sources.json`, validated at build time. Prerendered to dist/alexandria/sources.json.
 */
export function GET(): Response {
  return new Response(`${JSON.stringify(sourcesFile, null, 2)}\n`, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
