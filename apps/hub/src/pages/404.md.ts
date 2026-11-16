import { twinAt } from '../lib/all-twins.ts';
import { markdownResponse } from '../lib/twins.ts';

/** `/404.md`: the Markdown twin of the not-found page, so every manifest page has one (P3-S2). */
export async function GET(): Promise<Response> {
  return markdownResponse(await twinAt('/404.md'));
}
