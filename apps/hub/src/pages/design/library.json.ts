import { designLibrary } from '../../lib/design-library.ts';

/**
 * `/design/library.json`: the design resource library as data, the same file the repo commits at
 * `data/design-library.json`, validated at build time. Prerendered to dist/design/library.json.
 */
export function GET(): Response {
  return new Response(`${JSON.stringify(designLibrary, null, 2)}\n`, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
