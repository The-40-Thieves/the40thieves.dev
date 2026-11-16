import { twinAt } from '../../lib/all-twins.ts';
import { markdownResponse } from '../../lib/twins.ts';

/** `/alexandria/sources.md`: the Markdown twin of the source routing matrix (P4-S1). */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/alexandria/sources.md'));
}
