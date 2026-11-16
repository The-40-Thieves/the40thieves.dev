import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * The agent stack (P3-S5): the hub and the `mcp` Worker on one local origin, split the way
 * production splits them. Both run in local workerd through `wrangler dev`; a small proxy in
 * front sends `/mcp*` to the `mcp` Worker and everything else to the hub. Nothing here talks to
 * a Cloudflare account: KV is a temporary local store seeded from the hub build.
 *
 *   node scripts/agent-stack.ts [--port 8790]
 */

/** The path of the `mcp` Worker's route pattern (`the40thieves.dev/mcp*`), wildcard and all. */
export const MCP_ROUTE_PREFIX = '/mcp';

export type Upstream = 'hub' | 'mcp';

/** Which Worker the production route table hands this path to. */
export function upstreamFor(pathname: string): Upstream {
  return pathname.startsWith(MCP_ROUTE_PREFIX) ? 'mcp' : 'hub';
}

/**
 * The route table as a server: every request goes to its upstream with the method, headers and
 * body it arrived with, and the answer comes back untouched. The proxy adds and removes nothing,
 * so a check that passes through it reads what the Worker said.
 */
export function createFrontProxy(upstreams: Record<Upstream, string>): http.Server {
  return http.createServer((request, response) => {
    const path = request.url ?? '/';
    const name = upstreamFor(new URL(path, 'http://front').pathname);
    const forward = http.request(
      new URL(path, upstreams[name]),
      { method: request.method, headers: request.rawHeaders },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
        answer.pipe(response);
      },
    );
    forward.on('error', (error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          error: `agent-stack: the ${name} upstream is unreachable`,
          detail: error.message,
        }),
      );
    });
    request.pipe(forward);
  });
}

const ROOT = resolve(import.meta.dirname, '..');
const HUB_DIR = join(ROOT, 'apps', 'hub');
const MCP_DIR = join(ROOT, 'workers', 'mcp');
const HUB_CLIENT = join(HUB_DIR, 'dist', 'client');
/** The Worker config the hub build generates; naming it makes a bare `dist` directory enough. */
const HUB_CONFIG = join('dist', 'server', 'wrangler.json');
/** The two documents the deploy uploads to KV, and where the hub build leaves them. */
const KV_DOCUMENTS: readonly (readonly [key: string, file: string])[] = [
  ['manifest.json', join(HUB_CLIENT, 'manifest.json')],
  ['docs-index.json', join(HUB_CLIENT, 'mcp', 'docs-index.json')],
];

export const DEFAULT_STACK_PORT = 8790;

/** The five ports one stack takes, counted up from the one it serves on. */
export interface StackPorts {
  front: number;
  hub: number;
  mcp: number;
  hubInspector: number;
  mcpInspector: number;
}

export function stackPorts(port: number): StackPorts {
  return {
    front: port,
    hub: port + 1,
    mcp: port + 2,
    hubInspector: port + 3,
    mcpInspector: port + 4,
  };
}

/**
 * The `wrangler dev` command for each Worker. Each one names its inspector port: left to choose,
 * every `wrangler dev` settles on 9229, two started together both take it, and on Linux the
 * second exits with "Address already in use".
 */
export function workerCommands(port: number, state: string): Record<Upstream, string> {
  const ports = stackPorts(port);
  return {
    // The DSN is blanked so nothing here reports to the production Sentry project.
    hub: `pnpm exec wrangler dev -c ${HUB_CONFIG} --port ${String(ports.hub)} --inspector-port ${String(ports.hubInspector)} --ip 127.0.0.1 --var SENTRY_DSN:`,
    mcp: `pnpm exec wrangler dev --port ${String(ports.mcp)} --inspector-port ${String(ports.mcpInspector)} --ip 127.0.0.1 --local --persist-to "${state}"`,
  };
}

const READY_TIMEOUT_MS = 120_000;
const TAIL_LINES = 30;

interface Running {
  name: Upstream;
  child: ChildProcess;
  /** The last lines the process printed, for the error when it never becomes ready. */
  tail: string[];
}

/** One shell command string: `pnpm` is a `.cmd` shim on Windows and needs a shell there. */
function start(name: Upstream, command: string, cwd: string): Running {
  const child = spawn(command, {
    cwd,
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
  return { name, child, tail };
}

/** Stop a process and everything it started; `wrangler dev` runs workerd as a grandchild. */
function kill({ child }: Running): void {
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

/**
 * Which of these loopback ports something already listens on. A stack left behind by an
 * interrupted run would answer the readiness probe, and the run would be judged against
 * processes it did not start; so a taken port stops the start instead.
 */
export async function busyPorts(ports: readonly number[]): Promise<number[]> {
  const taken = await Promise.all(
    ports.map(
      (port) =>
        new Promise<boolean>((done) => {
          const socket = net.connect({ port, host: '127.0.0.1' });
          const settle = (busy: boolean) => {
            socket.destroy();
            done(busy);
          };
          socket.setTimeout(1000, () => {
            settle(false);
          });
          socket.once('connect', () => {
            settle(true);
          });
          socket.once('error', () => {
            settle(false);
          });
        }),
    ),
  );
  return ports.filter((_, index) => taken[index]);
}

/** The part of `process` the hooks below use; the tests pass a stand-in. */
interface ProcessLike {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  exit(code?: number): unknown;
}

/**
 * Run `cleanup` once when the process is interrupted (and then exit 130) or exits for any other
 * reason. It has to be synchronous: nothing awaited runs in an `exit` handler. Returns the
 * function that takes the hooks off again, for a normal stop.
 */
export function onProcessEnd(cleanup: () => void, target: ProcessLike = process): () => void {
  let cleaned = false;
  const once = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const interrupted = () => {
    once();
    target.exit(130);
  };
  target.on('exit', once);
  target.on('SIGINT', interrupted);
  target.on('SIGTERM', interrupted);
  return () => {
    target.off('exit', once);
    target.off('SIGINT', interrupted);
    target.off('SIGTERM', interrupted);
  };
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

export interface Stack {
  /** The one origin both Workers answer on. */
  url: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  port?: number;
  log?: (line: string) => void;
}

/**
 * Start both Workers and the proxy, and resolve once the hub's home page and the Worker's
 * healthz both answer 200 through it. Anything short of that stops what was started and throws
 * with the reason.
 */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const port = options.port ?? DEFAULT_STACK_PORT;
  const log = options.log ?? console.log;
  for (const [, file] of KV_DOCUMENTS) {
    if (!existsSync(file))
      throw new Error(`agent-stack: ${file} is missing; run \`pnpm build\` first`);
  }
  if (!existsSync(join(HUB_DIR, HUB_CONFIG))) {
    throw new Error(`agent-stack: apps/hub/${HUB_CONFIG} is missing; run \`pnpm build\` first`);
  }

  const ports = stackPorts(port);
  const busy = await busyPorts(Object.values(ports));
  if (busy.length > 0) {
    throw new Error(
      `agent-stack: port ${busy.join(', ')} is already in use. A stack from an earlier run may still be up: stop it first.`,
    );
  }

  const state = mkdtempSync(join(tmpdir(), 'agent-stack-'));
  const running: Running[] = [];
  // An interrupted run must not leave the Workers behind for the next one to mistake for its own.
  const release = onProcessEnd(() => {
    for (const entry of running) kill(entry);
    try {
      rmSync(state, { recursive: true, force: true });
    } catch {
      // workerd may still hold its files; a leftover temp directory is harmless.
    }
  });
  const front = createFrontProxy({
    hub: `http://127.0.0.1:${String(ports.hub)}`,
    mcp: `http://127.0.0.1:${String(ports.mcp)}`,
  });
  const url = `http://127.0.0.1:${String(port)}`;

  const stop = async (): Promise<void> => {
    release();
    for (const entry of running) kill(entry);
    await new Promise<void>((done) => {
      front.closeAllConnections();
      front.close(() => {
        done();
      });
    });
    try {
      // workerd can hold its SQLite files for a moment after it is killed.
      rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not worth failing a run over.
    }
  };

  try {
    for (const [key, file] of KV_DOCUMENTS) {
      const seeded = spawnSync(
        `pnpm exec wrangler kv key put ${key} --path "${file}" --binding MCP_KV --local --persist-to "${state}"`,
        { cwd: MCP_DIR, shell: true, encoding: 'utf8' },
      );
      if (seeded.status !== 0) {
        throw new Error(`agent-stack: seeding ${key} failed:\n${seeded.stdout}${seeded.stderr}`);
      }
    }
    const commands = workerCommands(port, state);
    running.push(start('mcp', commands.mcp, MCP_DIR), start('hub', commands.hub, HUB_DIR));
    await listen(front, port);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const [hub, mcp] = await Promise.all([answers(`${url}/`), answers(`${url}/mcp/healthz`)]);
      if (hub && mcp) break;
      const dead = running.find((entry) => entry.child.exitCode !== null);
      if (dead !== undefined || Date.now() > deadline) {
        const blamed = dead ?? running.find((entry) => entry.name === (mcp ? 'hub' : 'mcp'));
        const why = dead === undefined ? 'was not ready in time' : 'exited';
        throw new Error(
          `agent-stack: the ${blamed?.name ?? 'stack'} Worker ${why}:\n${(blamed?.tail ?? []).join('\n')}`,
        );
      }
      await new Promise((wait) => setTimeout(wait, 500));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  log(`agent-stack: ${url} (hub on ${String(ports.hub)}, mcp on ${String(ports.mcp)})`);
  return { url, stop };
}

export function parseStackArgs(argv: string[]): { port: number } {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' } } });
  const port = values.port === undefined ? DEFAULT_STACK_PORT : Number(values.port);
  // The stack takes this port and the four after it.
  if (!Number.isInteger(port) || port < 1024 || port > 65_531) {
    throw new Error(`--port must be a whole number from 1024 to 65531 (got ${values.port ?? ''})`);
  }
  return { port };
}

if (import.meta.main) {
  // Stays up until interrupted; `startStack` has hooked the signals and stops the Workers then.
  await startStack(parseStackArgs(process.argv.slice(2)));
}
