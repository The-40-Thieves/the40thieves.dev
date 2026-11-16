import { sourcesJsonSchemaDocument } from '@the40thieves/schemas';

/** The JSON Schema for `data/sources.json` (P4-S1). Prerendered to dist/schemas/sources.json. */
export function GET(): Response {
  return new Response(JSON.stringify(sourcesJsonSchemaDocument(), null, 2), {
    headers: { 'content-type': 'application/schema+json; charset=utf-8' },
  });
}
