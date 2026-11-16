import { designLibraryJsonSchemaDocument } from '@the40thieves/schemas';

/** The JSON Schema for `data/design-library.json`. Prerendered to dist/schemas/design-library.json. */
export function GET(): Response {
  return new Response(JSON.stringify(designLibraryJsonSchemaDocument(), null, 2), {
    headers: { 'content-type': 'application/schema+json; charset=utf-8' },
  });
}
