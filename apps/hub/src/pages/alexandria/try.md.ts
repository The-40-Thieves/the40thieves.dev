import { twinAt } from '../../lib/all-twins.ts';
import { markdownResponse } from '../../lib/twins.ts';

/** `/alexandria/try.md`: the Markdown twin of the try app (P4-S4). */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/alexandria/try.md'));
}
