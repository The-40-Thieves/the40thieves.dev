import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * The hub's runnable checks on Linux, from a machine that is not Linux: unit tests, the
 * agent-surface conformance suite and the Playwright specs, in a throwaway instabox box.
 * CI runs on ubuntu and a development machine may not; what differs between the two (port
 * binding, process groups, signals, the browser's system libraries) only shows when the code runs.
 *
 *   pnpm build && pnpm check:linux [--snapshot NAME] [--keep]
 *
 * The box gets the tracked files of this checkout and the `dist` built here; it does not build
 * (the build needs a GitHub token, and no credential goes into the box). What runs there is
 * `scripts/linux-check-box.sh`. The box is deleted when the check ends, and the server deletes it
 * after 30 minutes whatever happens to this process. `--keep` leaves it up for a look around.
 *
 * Needs the `instabox` CLI, signed in (https://instabox.sh/docs). The box starts from the default
 * template and installs the toolchain it lacks, about 20 s of a run that takes about a minute.
 * There is no default snapshot because one measured no faster: a box from a toolchain snapshot
 * skips those installs and takes as much longer to create (58 s against 53 s on 2026-11-09, and
 * 113 s the first time the snapshot was fetched). `--snapshot` is there for when that changes.
 */

/** Where the checkout lives in the box; HOME there is /data/home. */
const BOX_REPO = '/data/home/hub';
const BOX_SCRIPT = 'scripts/linux-check-box.sh';
/** The checks take about a minute; this is the most `instabox exec` allows. */
const CHECK_TIMEOUT_SECONDS = '600';

export interface LinuxCheckOptions {
  /** A snapshot to start from; `null`, the default, starts from the default template. */
  snapshot: string | null;
  keep: boolean;
}

export interface RunResult {
  status: number;
  stdout: string;
}

/** Everything the check does to the outside world, so the order of it can be tested. */
export interface Host {
  hasDist(): boolean;
  /** A copy of `dist` outside the repository, and its path. */
  stageDist(): string;
  boxName(): string;
  log(line: string): void;
  /** Run the `instabox` CLI; `capture` returns its stdout instead of printing it. */
  instabox(args: string[], options?: { capture?: boolean }): RunResult;
}

export function parseLinuxCheckArgs(argv: string[]): LinuxCheckOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      snapshot: { type: 'string' },
      keep: { type: 'boolean' },
    },
  });
  return { snapshot: values.snapshot ?? null, keep: values.keep ?? false };
}

/** The snapshot's name if the account has it ready to start from, else `null`. */
function readySnapshot(name: string, host: Host): string | null {
  const listing = host.instabox(['snapshot', 'ls', '--json'], { capture: true });
  let found = false;
  if (listing.status === 0) {
    try {
      const parsed: unknown = JSON.parse(listing.stdout);
      found =
        Array.isArray(parsed) &&
        parsed.some((entry: unknown) => {
          const snapshot = entry as { name?: unknown; status?: unknown };
          return snapshot.name === name && snapshot.status === 'ready';
        });
    } catch {
      found = false;
    }
  }
  if (!found) {
    host.log(
      `linux-check: no ready snapshot named ${name}; starting from the default template, which installs the toolchain first`,
    );
  }
  return found ? name : null;
}

/**
 * Create a box, upload the checkout and the build, run the checks, delete the box. Returns the
 * exit code of the checks; 2 when there is nothing built to check, 125 when the box could not be
 * made ready for them.
 */
export function runLinuxCheck(options: LinuxCheckOptions, host: Host): number {
  if (!host.hasDist()) {
    host.log(
      'linux-check: apps/hub/dist is missing. Run `pnpm build` first: the box runs what was built here.',
    );
    return 2;
  }
  const snapshot = options.snapshot === null ? null : readySnapshot(options.snapshot, host);
  const box = host.boxName();
  const created = host.instabox([
    'create',
    '--name',
    box,
    ...(snapshot === null ? [] : ['--snapshot', snapshot]),
    // A kept box pauses when it is left alone; any other is deleted by the server on a timer,
    // so an interrupted run leaves nothing behind for long.
    ...(options.keep ? ['--auto-suspend', '10m'] : ['--delete-after', '30m']),
    // The box only runs tests: none of the account's credentials are delivered into it.
    '--no-vault',
    '--secrets',
    'none',
  ]);
  if (created.status !== 0) {
    host.log(
      `linux-check: could not create a box (instabox create exited ${String(created.status)})`,
    );
    return 125;
  }
  try {
    // Inside a git repository `instabox push` sends the tracked files, as they are on disk.
    if (host.instabox(['push', box, '.', BOX_REPO]).status !== 0) {
      host.log('linux-check: uploading the checkout failed');
      return 125;
    }
    if (host.instabox(['push', box, host.stageDist(), `${BOX_REPO}/apps/hub/dist`]).status !== 0) {
      host.log('linux-check: uploading the build failed');
      return 125;
    }
    return host.instabox([
      'exec',
      box,
      '--cwd',
      BOX_REPO,
      '--stream',
      '--timeout',
      CHECK_TIMEOUT_SECONDS,
      '--',
      'bash',
      BOX_SCRIPT,
    ]).status;
  } finally {
    if (options.keep) {
      host.log(
        `linux-check: kept ${box}. Look around with \`instabox ssh ${box}\` (the checkout is in ${BOX_REPO}); delete it with \`instabox rm --yes ${box}\`.`,
      );
    } else {
      host.instabox(['rm', '--yes', box]);
    }
  }
}

function realHost(root: string): Host & { cleanup(): void } {
  const dist = join(root, 'apps', 'hub', 'dist');
  let staged: string | null = null;
  return {
    hasDist: () => existsSync(join(dist, 'server', 'wrangler.json')),
    stageDist() {
      // `dist` is ignored by git, and a push from inside the repository sends tracked files only.
      staged = mkdtempSync(join(tmpdir(), 'hub-linux-check-'));
      const copy = join(staged, 'dist');
      cpSync(dist, copy, { recursive: true });
      return copy;
    },
    boxName: () => `hub-check-${randomBytes(4).toString('hex')}`,
    log(line) {
      console.log(line);
    },
    instabox(args, options) {
      const result = spawnSync('instabox', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: options?.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      });
      if (result.error !== undefined) {
        throw new Error(
          `linux-check: could not run the instabox CLI (${result.error.message}). Install it and sign in: https://instabox.sh/docs`,
        );
      }
      return {
        status: result.status ?? 1,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
      };
    },
    cleanup() {
      if (staged !== null) rmSync(staged, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  let options: LinuxCheckOptions;
  try {
    options = parseLinuxCheckArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`linux-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const host = realHost(resolve(import.meta.dirname, '..'));
  try {
    process.exitCode = runLinuxCheck(options, host);
  } finally {
    host.cleanup();
  }
}
