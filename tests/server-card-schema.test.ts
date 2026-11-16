import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { buildServerCard } from '../workers/mcp/src/card.ts';
import {
  FIXTURE_DIR,
  SCHEMA_COMMIT,
  SCHEMA_SHA256,
  schemaSha256,
  validateServerCard,
} from './lib/server-card-schema.ts';

/**
 * P3-S3 acceptance: the card validates in CI against the pinned schema commit. The schema
 * and upstream's own examples are vendored byte for byte from
 * modelcontextprotocol/ext-server-card; this file proves the copy is the pinned one and that the
 * validator both accepts and rejects.
 */
function examples(kind: 'valid' | 'invalid'): [string, unknown][] {
  const dir = resolve(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as unknown]);
}

test("the hub's own card validates against the pinned schema", () => {
  expect(validateServerCard(buildServerCard('https://the40thieves.dev'))).toEqual({
    valid: true,
    errors: [],
  });
});

test('a card that drifts from the schema is rejected', () => {
  const card = buildServerCard('https://the40thieves.dev');
  // The server's own name has no namespace; the schema wants `namespace/name`.
  expect(validateServerCard({ ...card, name: 'the40thieves.dev' }).valid).toBe(false);
  expect(validateServerCard({ ...card, description: 'x'.repeat(101) }).valid).toBe(false);
  expect(
    validateServerCard({ ...card, remotes: [{ type: 'websocket', url: card.remotes[0]?.url }] })
      .valid,
  ).toBe(false);
});

test('the vendored schema is byte for byte the pinned commit', () => {
  expect(schemaSha256()).toBe(SCHEMA_SHA256);
});

test('the fixture README names the commit the pin test checks', () => {
  expect(readFileSync(resolve(FIXTURE_DIR, 'README.md'), 'utf8')).toContain(SCHEMA_COMMIT);
});

test('upstream valid examples validate cleanly', () => {
  const valid = examples('valid');
  expect(valid.map(([name]) => name)).toEqual(['minimal.json', 'templated-remote.json']);
  for (const [name, card] of valid) {
    expect(validateServerCard(card), name).toEqual({ valid: true, errors: [] });
  }
});

test('upstream invalid examples are rejected, so a pass means the card was checked', () => {
  const invalid = examples('invalid');
  expect(invalid.map(([name]) => name)).toEqual([
    'bad-name-pattern.json',
    'date-versioned-schema.json',
    'missing-name.json',
    'missing-schema.json',
    'wrong-schema-name.json',
  ]);
  for (const [name, card] of invalid) {
    const result = validateServerCard(card);
    expect(result.valid, name).toBe(false);
    expect(result.errors.length, name).toBeGreaterThan(0);
  }
});
