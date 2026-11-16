import { collectTwins } from '../lib/all-twins.ts';
import { llmsFull } from '../lib/twins.ts';

/** `/llms-full.txt`: every Markdown twin in one file, under 1 MB (P3-S2). */
export async function GET(): Promise<Response> {
  const { manifest, twins } = await collectTwins();
  return new Response(llmsFull(manifest, twins), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
