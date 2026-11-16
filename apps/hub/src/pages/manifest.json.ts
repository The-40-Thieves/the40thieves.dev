import { collectTwins } from '../lib/all-twins.ts';

/** The allowlist every surface renders from (P2-05). Prerendered to dist/manifest.json. */
export async function GET(): Promise<Response> {
  const { manifest } = await collectTwins();
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
