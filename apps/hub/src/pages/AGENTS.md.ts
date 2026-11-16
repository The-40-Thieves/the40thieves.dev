import { collectTwins } from '../lib/all-twins.ts';
import { agentsMd, markdownResponse } from '../lib/twins.ts';

/** `/AGENTS.md`: how agents should read the site, generated from the manifest (P3-S2). */
export async function GET(): Promise<Response> {
  const { manifest } = await collectTwins();
  return markdownResponse(agentsMd(manifest));
}
