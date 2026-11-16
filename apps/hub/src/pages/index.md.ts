import { twinAt } from '../lib/all-twins.ts';
import { markdownResponse } from '../lib/twins.ts';

/** `/index.md`: the Markdown twin of the home page (P3-S2). */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/index.md'));
}
