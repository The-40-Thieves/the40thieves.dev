import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * The MCP Server Card schema (SEP-2127), vendored from modelcontextprotocol/ext-server-card at
 * one commit. P3-S3 gates the hub's card on this exact copy; bump the commit, the hash and
 * the fixture files together.
 */
export const SCHEMA_COMMIT = '526201bbc80231daa40ffcdecfc9da4e54e5dc93';
export const SCHEMA_SHA256 = '2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042';

export const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/ext-server-card');

function schemaText(): string {
  // Upstream is LF; a checkout that rewrote line endings must still hash the same.
  return readFileSync(resolve(FIXTURE_DIR, 'schema.json'), 'utf8').replaceAll('\r\n', '\n');
}

/** SHA-256 of the vendored `schema.json`, hex. */
export function schemaSha256(): string {
  return createHash('sha256').update(schemaText()).digest('hex');
}

export interface CardValidation {
  valid: boolean;
  /** One `instancePath message` line per violation; empty when valid. */
  errors: string[];
}

const SCHEMA_ID = 'schema.json';

function compile() {
  // The settings upstream's own example validator uses: draft 2020-12, formats enforced.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  ajv.addSchema(JSON.parse(schemaText()) as object, SCHEMA_ID);
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/ServerCard`);
  if (!validate) throw new Error('The vendored schema has no $defs/ServerCard');
  return validate;
}

let compiled: ReturnType<typeof compile> | undefined;

/** Validate a document against `#/$defs/ServerCard` of the pinned schema. */
export function validateServerCard(card: unknown): CardValidation {
  compiled ??= compile();
  const valid = compiled(card) === true;
  const errors = (compiled.errors ?? []).map((error) =>
    `${error.instancePath} ${error.message ?? 'is invalid'}`.trim(),
  );
  return { valid, errors: valid ? [] : errors };
}
