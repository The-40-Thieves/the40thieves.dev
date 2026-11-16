import { expect, test } from 'vitest';

import { checkWorkflows, checkWorkflowText } from '../scripts/check-pinned-actions.ts';

test('flags tag pins, allows sha pins, local and docker actions', () => {
  const text = [
    'uses: actions/checkout@v7',
    'uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7.0.1',
    'uses: ./.github/actions/local',
    'uses: docker://alpine:3.20',
  ].join('\n');
  const violations = checkWorkflowText('ci.yml', text);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ file: 'ci.yml', line: 1, reason: 'unpinned' });
});

test('allows the $/ self-repository syntax for local actions and workflows', () => {
  const text = ['uses: $/.github/actions/setup', 'uses: $/.github/workflows/ci.yml'].join('\n');
  expect(checkWorkflowText('deploy.yml', text)).toEqual([]);
});

test('flags a reusable workflow pinned to a branch', () => {
  const text =
    'jobs:\n  osv:\n    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@main';
  expect(checkWorkflowText('ci.yml', text)).toMatchObject([{ line: 3, reason: 'unpinned' }]);
});

test('accepts a reusable workflow pinned to a sha', () => {
  const text =
    'uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@0123456789abcdef0123456789abcdef01234567 # v2.7.0';
  expect(checkWorkflowText('ci.yml', text)).toEqual([]);
});

test('flags pull_request_target with checkout of the PR head', () => {
  const text =
    'on:\n  pull_request_target:\nsteps:\n  - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n    with:\n      ref: ${{ github.event.pull_request.head.sha }}';
  expect(
    checkWorkflowText('x.yml', text).some((v) => v.reason === 'pull_request_target_checkout_head'),
  ).toBe(true);
});

test('does not flag a plain pull_request checkout of the head', () => {
  const text =
    'on:\n  pull_request:\nsteps:\n  - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n    with:\n      ref: ${{ github.event.pull_request.head.sha }}';
  expect(checkWorkflowText('x.yml', text)).toEqual([]);
});

test('checkWorkflows walks a .github tree: workflows and composite action.yml files', () => {
  const violations = checkWorkflows('tests/fixtures/github');
  expect(violations.map((v) => [v.file, v.line, v.reason])).toEqual([
    ['tests/fixtures/github/actions/setup/action.yml', 5, 'unpinned'],
    ['tests/fixtures/github/workflows/a.yml', 5, 'unpinned'],
  ]);
});
