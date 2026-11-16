import { buildDocsIndex } from '@the40thieves/manifest';

import { collectTwins } from '../../lib/all-twins.ts';
import { agentsMd } from '../../lib/twins.ts';

/**
 * The docs search index the `/mcp` Worker reads from KV (P3-S1): every Markdown twin
 * plus AGENTS.md, as MiniSearch JSON. Prerendered to dist/client/mcp/docs-index.json for the
 * deploy to upload; on the live zone the `/mcp*` route belongs to the Worker, so the hub
 * never serves it, and its content is the public twins in another shape.
 */
export async function GET(): Promise<Response> {
  const { manifest, twins } = await collectTwins();
  const docs = [
    ...twins.map((twin) => ({ path: twin.path, text: twin.markdown })),
    { path: '/AGENTS.md', text: agentsMd(manifest) },
  ];
  const index = buildDocsIndex(docs, __BUILD_INFO__.generatedAt);
  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
