import { hubJsonSchemaDocument } from '@the40thieves/schemas';

/** The JSON Schema for a repository's `hub.json` (P1-04). Prerendered to dist/schemas/hub.json. */
export function GET(): Response {
  return new Response(JSON.stringify(hubJsonSchemaDocument(), null, 2), {
    headers: { 'content-type': 'application/schema+json; charset=utf-8' },
  });
}
