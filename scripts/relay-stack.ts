import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { busyPorts, onProcessEnd } from './agent-stack.ts';

/**
 * The relay stack (P4-S2): the `relay` Worker's production handler in local workerd, behind
 * `workers/relay/wrangler.stack.jsonc`, with a mock upstream on loopback as its only reachable
 * host. It is what the relay-zap job scans; nothing here contacts a real host or Cloudflare.
 * It prints a session token and then `ready`, and stays up until interrupted.
 *
 *   node scripts/relay-stack.ts [--port 8795] [--count-file <path>]
 */

export const DEFAULT_RELAY_STACK_PORT = 8795;
/** The stack's inspector sits this far above its port: 9231 by default, clear of 9229 and agent-stack. */
const INSPECTOR_OFFSET = 436;

/** What the mock upstream answers to every request. Fixed, so nothing a scanner sends is echoed. */
export const MOCK_UPSTREAM_BODY = '{"ok":true,"upstream":"mock"}';
/** The token the stack's Turnstile check accepts (Cloudflare's test sitekey token). */
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const ROOT = resolve(import.meta.dirname, '..');
const RELAY_DIR = join(ROOT, 'workers', 'relay');
const READY_TIMEOUT_MS = 120_000;
const TAIL_LINES = 30;

export interface RelayStackPorts {
  relay: number;
  upstream: number;
  inspector: number;
}

export function relayStackPorts(port: number): RelayStackPorts {
  return { relay: port, upstream: port + 1, inspector: port + INSPECTOR_OFFSET };
}

/**
 * The `wrangler dev` command, run from workers/relay. It names its inspector port: two `wrangler
 * dev` processes left to choose both take 9229, and on Linux the second one exits.
 */
export function relayWorkerCommand(port: number): string {
  const ports = relayStackPorts(port);
  const loopback = (at: number) => `http://127.0.0.1:${String(at)}`;
  return [
    'pnpm exec wrangler dev --config wrangler.stack.jsonc',
    `--port ${String(ports.relay)}`,
    `--inspector-port ${String(ports.inspector)}`,
    '--ip 127.0.0.1 --local',
    `--var SITE:${loopback(ports.relay)}`,
    `--var UPSTREAM:${loopback(ports.upstream)}`,
  ].join(' ');
}

/**
 * The mock upstream: one fixed JSON body for any method and path; a request body is read and
 * dropped. With `countFile`, the number of requests answered so far is written there, "0" at once
 * and rewritten on every answer, so a scan can be shown to have got past the relay's checks.
 */
export function createMockUpstream(options: { countFile?: string } = {}): http.Server {
  const { countFile } = options;
  let answered = 0;
  if (countFile !== undefined) writeFileSync(countFile, '0\n');
  return http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      answered += 1;
      if (countFile !== undefined) writeFileSync(countFile, `${String(answered)}\n`);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : MOCK_UPSTREAM_BODY);
    });
  });
}

export interface RelayStackArgs {
  port: number;
  /** Where the mock upstream keeps its count of answered requests; none when unset. */
  countFile?: string;
}

export function parseRelayStackArgs(argv: string[]): RelayStackArgs {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' }, 'count-file': { type: 'string' } },
  });
  const port = values.port === undefined ? DEFAULT_RELAY_STACK_PORT : Number(values.port);
  // The stack takes this port, the next one and the inspector port above them.
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 - INSPECTOR_OFFSET) {
    throw new Error(
      `--port must be a whole number from 1024 to ${String(65_535 - INSPECTOR_OFFSET)} (got ${values.port ?? ''})`,
    );
  }
  const countFile = values['count-file'];
  if (countFile === '') throw new Error('--count-file needs a path');
  return countFile === undefined ? { port } : { port, countFile };
}

/** Stop wrangler and everything it started; it runs workerd as a grandchild. */
function kill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v1/healthz`, { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

/** A session from the stack's own `/v1/session`, the way the browser app will ask for one. */
async function mintSession(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/session`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ token: TURNSTILE_DUMMY_TOKEN }),
  });
  const answer = (await response.json()) as { session?: unknown };
  if (response.status !== 200 || typeof answer.session !== 'string') {
    throw new Error(`relay-stack: /v1/session answered ${String(response.status)}`);
  }
  return answer.session;
}

export interface RelayStack {
  url: string;
  session: string;
  stop(): Promise<void>;
}

/** Start the mock upstream and the Worker, and resolve once healthz answers and a session is minted. */
export async function startRelayStack(
  options: {
    port?: number;
    countFile?: string;
    log?: (line: string) => void;
    /** Pass wrangler's own output on to this process's stdout and stderr (the CLI does). */
    echoWorker?: boolean;
  } = {},
): Promise<RelayStack> {
  const port = options.port ?? DEFAULT_RELAY_STACK_PORT;
  const log = options.log ?? console.log;
  const ports = relayStackPorts(port);
  const busy = await busyPorts(Object.values(ports));
  if (busy.length > 0) {
    throw new Error(
      `relay-stack: port ${busy.join(', ')} is already in use. A stack from an earlier run may still be up: stop it first.`,
    );
  }

  const upstream = createMockUpstream(
    options.countFile === undefined ? {} : { countFile: options.countFile },
  );
  // Not spawnSync: the mock upstream runs in this process and has to keep answering.
  const child = spawn(relayWorkerCommand(port), {
    cwd: RELAY_DIR,
    shell: true,
    // Its own process group, so the whole tree can be signalled on POSIX.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    tail.push(
      ...chunk
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== ''),
    );
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  if (options.echoWorker === true) {
    // The relay's log lines carry a hostname at most: no URL, header value or session.
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }

  // An interrupted run must not leave workerd behind for the next one to mistake for its own.
  const release = onProcessEnd(() => {
    kill(child);
    upstream.closeAllConnections();
    upstream.close();
  });
  const stop = async (): Promise<void> => {
    release();
    kill(child);
    await new Promise<void>((done) => {
      upstream.closeAllConnections();
      upstream.close(() => {
        done();
      });
    });
  };

  const url = `http://127.0.0.1:${String(ports.relay)}`;
  let session: string;
  try {
    await new Promise<void>((done, fail) => {
      upstream.once('error', fail);
      upstream.listen(ports.upstream, '127.0.0.1', () => {
        upstream.off('error', fail);
        done();
      });
    });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await healthy(url))) {
      const why =
        child.exitCode !== null ? 'exited' : Date.now() > deadline ? 'was not ready in time' : null;
      if (why !== null)
        throw new Error(`relay-stack: the relay Worker ${why}:\n${tail.join('\n')}`);
      await new Promise((wait) => setTimeout(wait, 500));
    }
    session = await mintSession(url);
  } catch (error) {
    await stop();
    throw error;
  }
  log(`relay-stack: session ${session}`);
  log(`relay-stack: ready ${url} (mock upstream on ${String(ports.upstream)})`);
  return { url, session, stop };
}

if (import.meta.main) {
  // Stays up until interrupted; `startRelayStack` has hooked the signals and stops both then.
  await startRelayStack({ ...parseRelayStackArgs(process.argv.slice(2)), echoWorker: true });
}
