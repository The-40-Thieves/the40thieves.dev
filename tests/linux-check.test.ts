import { expect, test } from 'vitest';

import {
  type Host,
  type RunResult,
  parseLinuxCheckArgs,
  runLinuxCheck,
} from '../scripts/linux-check.ts';

interface Call {
  args: string[];
}

/** A host that records every `instabox` call and answers from a table keyed by subcommand. */
function fakeHost(overrides: {
  dist?: boolean;
  snapshots?: { name: string; status: string }[];
  status?: Partial<Record<string, number>>;
}) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const host: Host = {
    hasDist: () => overrides.dist ?? true,
    stageDist: () => '/tmp/staged/dist',
    boxName: () => 'hub-check-abc123',
    log: (line) => lines.push(line),
    instabox(args): RunResult {
      calls.push({ args });
      const key = args[0] === 'snapshot' ? 'snapshot' : (args[0] ?? '');
      const status = overrides.status?.[key] ?? 0;
      const stdout =
        key === 'snapshot'
          ? JSON.stringify(overrides.snapshots ?? [{ name: 'toolchain', status: 'ready' }])
          : '';
      return { status, stdout };
    },
  };
  const verbs = () => calls.map((call) => call.args[0]);
  const find = (verb: string) => calls.find((call) => call.args[0] === verb)?.args ?? [];
  return { host, calls, lines, verbs, find };
}

const DEFAULTS = { snapshot: null, keep: false };

test('the arguments default to a box from the template that is deleted afterwards', () => {
  expect(parseLinuxCheckArgs([])).toEqual({ snapshot: null, keep: false });
  expect(parseLinuxCheckArgs(['--snapshot', 'other', '--keep'])).toEqual({
    snapshot: 'other',
    keep: true,
  });
  expect(() => parseLinuxCheckArgs(['--nope'])).toThrow();
});

test('without a build nothing is created and the message says what to run', () => {
  const fake = fakeHost({ dist: false });
  expect(runLinuxCheck(DEFAULTS, fake.host)).toBe(2);
  expect(fake.calls).toEqual([]);
  expect(fake.lines.join('\n')).toContain('pnpm build');
});

test('a passing check creates the box, uploads, runs and deletes it, in that order', () => {
  const fake = fakeHost({});
  expect(runLinuxCheck(DEFAULTS, fake.host)).toBe(0);
  expect(fake.verbs()).toEqual(['create', 'push', 'push', 'exec', 'rm']);

  const create = fake.find('create');
  expect(create).toEqual(expect.arrayContaining(['--name', 'hub-check-abc123']));
  // From the default template: the run does not depend on anything stored in the account.
  expect(create).not.toContain('--snapshot');
  // The server deletes the box even if this process dies before it can.
  expect(create).toEqual(expect.arrayContaining(['--delete-after', '30m']));
  // No credential of the account is delivered into a box that only runs tests.
  expect(create).toEqual(expect.arrayContaining(['--no-vault', '--secrets', 'none']));

  const [repo, dist] = fake.calls.filter((call) => call.args[0] === 'push');
  expect(repo?.args).toEqual(['push', 'hub-check-abc123', '.', '/data/home/hub']);
  expect(dist?.args).toEqual([
    'push',
    'hub-check-abc123',
    '/tmp/staged/dist',
    '/data/home/hub/apps/hub/dist',
  ]);

  const exec = fake.find('exec');
  expect(exec.slice(0, 2)).toEqual(['exec', 'hub-check-abc123']);
  expect(exec).toEqual(expect.arrayContaining(['--cwd', '/data/home/hub', '--stream']));
  expect(exec.slice(-2)).toEqual(['bash', 'scripts/linux-check-box.sh']);

  expect(fake.find('rm')).toEqual(['rm', '--yes', 'hub-check-abc123']);
});

test('a failing check still deletes the box and returns the exit code of the check', () => {
  const fake = fakeHost({ status: { exec: 1 } });
  expect(runLinuxCheck(DEFAULTS, fake.host)).toBe(1);
  expect(fake.verbs().at(-1)).toBe('rm');
});

test('an upload that fails stops before the check, deletes the box and returns 125', () => {
  const fake = fakeHost({ status: { push: 1 } });
  expect(runLinuxCheck(DEFAULTS, fake.host)).toBe(125);
  expect(fake.verbs()).toEqual(['create', 'push', 'rm']);
});

test('a box that cannot be created is reported, and there is nothing to delete', () => {
  const fake = fakeHost({ status: { create: 75 } });
  expect(runLinuxCheck(DEFAULTS, fake.host)).toBe(125);
  expect(fake.verbs()).toEqual(['create']);
  expect(fake.lines.join('\n')).toContain('could not create');
});

test('--snapshot starts the box from that snapshot when the account has it ready', () => {
  const fake = fakeHost({});
  expect(runLinuxCheck({ snapshot: 'toolchain', keep: false }, fake.host)).toBe(0);
  expect(fake.verbs()).toEqual(['snapshot', 'create', 'push', 'push', 'exec', 'rm']);
  expect(fake.find('create')).toEqual(expect.arrayContaining(['--snapshot', 'toolchain']));
});

test('a snapshot that is missing or not ready falls back to the template and says so', () => {
  for (const snapshots of [[], [{ name: 'toolchain', status: 'pending' }]]) {
    const fake = fakeHost({ snapshots });
    expect(runLinuxCheck({ snapshot: 'toolchain', keep: false }, fake.host)).toBe(0);
    expect(fake.find('create')).not.toContain('--snapshot');
    expect(fake.lines.join('\n')).toContain('installs the toolchain');
  }
});

test('--keep leaves the box up and says how to reach and delete it', () => {
  const fake = fakeHost({ status: { exec: 1 } });
  expect(runLinuxCheck({ snapshot: null, keep: true }, fake.host)).toBe(1);
  expect(fake.verbs()).not.toContain('rm');
  // A kept box must not be deleted from under whoever is looking at it.
  expect(fake.find('create')).not.toContain('--delete-after');
  const said = fake.lines.join('\n');
  expect(said).toContain('instabox ssh hub-check-abc123');
  expect(said).toContain('instabox rm --yes hub-check-abc123');
});
