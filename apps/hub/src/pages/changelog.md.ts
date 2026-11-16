import { twinAt } from '../lib/all-twins.ts';
import { markdownResponse } from '../lib/twins.ts';

/** `/changelog.md`: the Markdown twin of the changelog (P3-S2). */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/changelog.md'));
}
