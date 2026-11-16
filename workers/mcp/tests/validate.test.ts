import type { ManifestProject } from '@the40thieves/schemas';
import { expect, test } from 'vitest';

import { validateConfig } from '../src/validate.ts';

const project: ManifestProject = {
  slug: 'codecalc',
  name: 'CodeCalc',
  tagline: 'A calculator for agents',
  description: null,
  listed: true,
  repo: 'https://github.com/The-40-Thieves/codecalc',
  page: '/codecalc/',
  release: null,
  install: {
    shell: "uvx 'codecalc[full]' setup --write",
    'claude-code': "claude mcp add codecalc -- uvx 'codecalc[full]'",
    cursor: '{ "mcpServers": { "codecalc": { "command": "uvx", "args": ["codecalc[full]"] } } }',
    vscode: '{ "servers": { "codecalc": { "command": "uvx", "args": ["codecalc[full]"] } } }',
  },
  docs: null,
  source: { repo: 'The-40-Thieves/the40thieves.dev', path: 'x', sha: 'c'.repeat(40) },
};

test('the published snippet itself is valid, as a string or as an object', () => {
  const asString = validateConfig(project, 'cursor', project.install.cursor ?? '');
  expect(asString).toEqual({
    valid: true,
    issues: [],
    expected: { mcpServers: { codecalc: { command: 'uvx', args: ['codecalc[full]'] } } },
  });
  const asObject = validateConfig(project, 'vscode', {
    servers: { codecalc: { command: 'uvx', args: ['codecalc[full]'] } },
  });
  expect(asObject.valid).toBe(true);
});

test('other servers beside the entry and an env block inside it are not differences', () => {
  const result = validateConfig(project, 'cursor', {
    mcpServers: {
      other: { command: 'npx', args: ['-y', 'other'] },
      codecalc: { command: 'uvx', args: ['codecalc[full]'], env: { RUST_LOG: 'info' } },
    },
  });
  expect(result).toMatchObject({ valid: true, issues: [] });
});

test('a config for another project (right shape, wrong entry) reports the missing entry', () => {
  const result = validateConfig(project, 'cursor', {
    mcpServers: { other: { command: 'uvx', args: ['other'] } },
  });
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([
    { path: 'mcpServers.codecalc', message: 'missing; expected an object' },
  ]);
});

test('a wrong command and a wrong argument are each one issue with the path to the value', () => {
  const result = validateConfig(project, 'cursor', {
    mcpServers: { codecalc: { command: 'npx', args: ['codecalc'] } },
  });
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([
    { path: 'mcpServers.codecalc.command', message: 'expected "uvx", got "npx"' },
    { path: 'mcpServers.codecalc.args[0]', message: 'expected "codecalc[full]", got "codecalc"' },
  ]);
});

test('a missing args array and a wrong container are reported', () => {
  const result = validateConfig(project, 'vscode', {
    mcpServers: { codecalc: { command: 'uvx', args: ['codecalc[full]'] } },
  });
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([{ path: 'servers', message: 'missing; expected an object' }]);
  const noArgs = validateConfig(project, 'vscode', { servers: { codecalc: { command: 'uvx' } } });
  expect(noArgs.issues).toEqual([
    { path: 'servers.codecalc.args', message: 'missing; expected an array' },
  ]);
});

test('a string that is not JSON is one issue at the root', () => {
  const result = validateConfig(project, 'cursor', '{ not json');
  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]?.path).toBe('');
  expect(result.issues[0]?.message).toMatch(/not JSON/);
});

test('a project with no snippet for the client cannot be validated', () => {
  const bare: ManifestProject = {
    ...project,
    install: { shell: null, 'claude-code': null, cursor: null, vscode: null },
  };
  const result = validateConfig(bare, 'cursor', {});
  expect(result).toEqual({
    valid: false,
    issues: [{ path: '', message: 'codecalc publishes no cursor snippet' }],
    expected: null,
  });
});
