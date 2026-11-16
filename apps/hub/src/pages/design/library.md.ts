import { twinAt } from '../../lib/all-twins.ts';
import { markdownResponse } from '../../lib/twins.ts';

/** `/design/library.md`: the Markdown twin of the design resource library. */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/design/library.md'));
}
