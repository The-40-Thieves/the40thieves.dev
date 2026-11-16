import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { sourcesFileSchema, type SourcesFile } from '@the40thieves/schemas';

import {
  buildSourcesFile,
  diffSourcesFiles,
  entryFor,
  isSimpleRequestHeader,
  PROBE_ORIGIN,
  probeEnv,
  renderSourcesFile,
  UPSTREAM_REPO,
  type Capture,
  type UpstreamSource,
} from './lib/probe-sources.ts';
import { repoRoot } from './lib/policy.ts';

/**
 * The alexandria source probe (P4-S1): writes `data/sources.json`, the routing matrix the
 * `/alexandria/sources/` page renders, the relay (P4-S2) takes its allowlist from and the BYOK
 * app (P4-S4) routes by.
 *
 * How it works. alexandria-mcp (`The-40-Thieves/alexandria-mcp`, public) is shallow-cloned at
 * `--ref` (default `main`) into a temp dir and `npm ci --ignore-scripts` runs there; its registry
 * (`src/sources/all.ts`) is then imported in this process, which works because upstream targets
 * Node 24 or newer with erasable TypeScript only, and this repo runs Node 26. Every declared key
 * env gets a placeholder value so keyed adapters build and send their request; every optional env
 * is cleared so a token on this machine never changes a verdict. While each adapter's `search()`
 * runs once, a recorder stands in for `globalThis.fetch`: it adds `Origin: https://the40thieves.dev`,
 * attributes the request to its source through `AsyncLocalStorage`, keeps the host, the request
 * header names and the CORS response headers, and sends one OPTIONS preflight when a non-simple
 * header was present. It never keeps a URL (a key may ride in the query string) or a key value.
 * Remote MCP and scraped sources are not searched: their route is MCP-only by kind.
 *
 * `--check` renders the file and compares it with the committed one (exit 1 on a difference, file
 * untouched); the weekly workflow `sources-probe.yml` instead writes it and opens a PR on change.
 * A write over an existing file logs what changed per source first. More than `--max-failed`
 * sources failing (default 25; the committed file has about a dozen) is a bad network, not a
 * changed world: nothing is written and the exit is 2, so the weekly job cannot propose a mass
 * demotion. `--only <name>` needs `--out`, so a one-source file never lands on the committed one.
 * Exit codes: 0 written or matching, 1 `--check` difference, 2 too many failures, 125 clone or
 * install failed.
 */

export const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPO}.git`;
export const PROBE_QUERY = 'history of science';
export const PROBE_LIMIT = 2;
const DEFAULT_OUT = 'data/sources.json';
const DIFF_CAP = 80;

/** Kinds whose adapters are never run: the browser cannot reach them and the relay will not. */
const SKIPPED_KINDS = new Set(['mcp', 'scrape']);

export interface Registry {
  list(): UpstreamSource[];
  search(name: string, query: string, limit: number): Promise<unknown[]>;
}

/** Everything with a side effect, so tests run the orchestration with a fake. */
export interface ProbeHost {
  /** Clone upstream at `ref` and install its dependencies; resolves the checked-out commit. */
  prepare(ref: string): Promise<{ dir: string; commit: string }>;
  /** Import the registry from the prepared clone. */
  load(dir: string): Promise<Registry>;
  /** The unpatched fetch the recorder forwards to and sends preflights through. */
  fetch: typeof fetch;
  log(line: string): void;
  cleanup(): void;
}

export interface ProbeOptions {
  ref: string;
  out: string;
  check: boolean;
  only: string | null;
  concurrency: number;
  timeoutMs: number;
  /** Failed sources above this count mean the run, not the world, is broken: exit 2, no write. */
  maxFailed: number;
}

export function parseProbeArgs(argv: string[]): ProbeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
      only: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      'max-failed': { type: 'string' },
    },
    strict: true,
  });
  if (values.only !== undefined && values.out === undefined) {
    throw new Error(
      `--only ${values.only} writes a one-source file; give it --out <file> so ${DEFAULT_OUT} stays whole`,
    );
  }
  return {
    ref: values.ref ?? 'main',
    out: values.out ?? DEFAULT_OUT,
    check: values.check ?? false,
    only: values.only ?? null,
    concurrency: values.concurrency ? Number.parseInt(values.concurrency, 10) : 6,
    timeoutMs: values.timeout ? Number.parseInt(values.timeout, 10) : 25_000,
    maxFailed: values['max-failed'] ? Number.parseInt(values['max-failed'], 10) : 25,
  };
}

const TIMED_OUT = Symbol('timed out');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      done(TIMED_OUT);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A short, URL-free account of why a search threw; `HTTP <code>` when the message carries one. */
export function probeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const http = /\bHTTP (\d{3})\b/.exec(message);
  if (http?.[1]) return `HTTP ${http[1]}`;
  const name = error instanceof Error ? error.name : 'Error';
  const clean = message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim();
  return `${name}: ${clean}`.slice(0, 120);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestHeaders(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof input === 'object' && !(input instanceof URL)) return new Headers(input.headers);
  return new Headers();
}

/**
 * The fetch that stands in for the global one while the adapters run. `name` comes from the
 * storage the search was started under, so concurrent searches never mix their captures.
 */
function recorder(
  host: ProbeHost,
  storage: AsyncLocalStorage<string>,
  captures: Map<string, Capture[]>,
): typeof fetch {
  const preflighted = new Set<string>();
  return async (input, init) => {
    const name = storage.getStore();
    const url = requestUrl(input);
    const headers = requestHeaders(input, init);
    headers.set('origin', PROBE_ORIGIN);
    const response = await host.fetch(input, { ...init, headers });
    if (name === undefined) return response;
    const method = (init?.method ?? 'GET').toUpperCase();
    // Names only, never values; content-type is kept only when its value makes the request
    // non-simple (a JSON body), so the verdict can tell it from a form post later.
    const sent = [...headers.keys()]
      .map((header) => header.toLowerCase())
      .filter(
        (header) =>
          header !== 'content-type' || !isSimpleRequestHeader(header, headers.get(header)),
      )
      .sort();
    const nonSimple = sent.filter((header) => !isSimpleRequestHeader(header, headers.get(header)));
    let hostName: string;
    try {
      hostName = new URL(url).host;
    } catch {
      return response;
    }
    let preflight: Capture['preflight'] = null;
    if (nonSimple.length > 0) {
      const key = `${name} ${hostName} ${nonSimple.join(',')}`;
      if (!preflighted.has(key)) {
        preflighted.add(key);
        try {
          const options = await host.fetch(url, {
            method: 'OPTIONS',
            headers: {
              origin: PROBE_ORIGIN,
              'access-control-request-method': method,
              'access-control-request-headers': nonSimple.join(', '),
            },
          });
          preflight = {
            acao: options.headers.get('access-control-allow-origin'),
            allowHeaders: options.headers.get('access-control-allow-headers'),
          };
        } catch {
          preflight = null;
        }
      } else {
        // A retry of a request already preflighted: reuse that verdict.
        const earlier = (captures.get(name) ?? []).find(
          (capture) => capture.host === hostName && capture.preflight !== null,
        );
        preflight = earlier?.preflight ?? null;
      }
    }
    const list = captures.get(name) ?? [];
    list.push({
      host: hostName,
      requestHeaders: sent,
      status: response.status,
      acao: response.headers.get('access-control-allow-origin'),
      preflight,
    });
    captures.set(name, list);
    return response;
  };
}

/** Set or (with `undefined`) remove one variable; `delete` on a computed key is a lint error. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function applyEnv(env: { set: Record<string, string>; unset: string[] }): () => void {
  const previous = new Map<string, string | undefined>();
  for (const name of [...Object.keys(env.set), ...env.unset, 'ALEXANDRIA_STATE_DB']) {
    previous.set(name, process.env[name]);
  }
  for (const [name, value] of Object.entries(env.set)) setEnv(name, value);
  for (const name of env.unset) setEnv(name, undefined);
  setEnv('ALEXANDRIA_STATE_DB', ':memory:');
  return () => {
    for (const [name, value] of previous) setEnv(name, value);
  };
}

function diffLines(expected: string, actual: string): string[] {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < DIFF_CAP; i++) {
    const expectedLine = a[i];
    const actualLine = b[i];
    if (expectedLine === actualLine) continue;
    if (expectedLine !== undefined) out.push(`-${expectedLine}`);
    if (actualLine !== undefined) out.push(`+${actualLine}`);
  }
  if (out.length >= DIFF_CAP) out.push(`... (first ${String(DIFF_CAP)} differing lines shown)`);
  return out;
}

/** Per-source lines when the committed file parses; a positional line diff when it does not. */
function describeDifference(current: string, next: SourcesFile, nextText: string): string[] {
  let parsed: SourcesFile | null = null;
  try {
    parsed = sourcesFileSchema.parse(JSON.parse(current));
  } catch {
    parsed = null;
  }
  if (parsed === null)
    return current === '' ? ['(no committed file)'] : diffLines(current, nextText);
  const lines = diffSourcesFiles(parsed, next);
  return lines.length > 0 ? lines : diffLines(current, nextText);
}

async function probeAll(
  sources: UpstreamSource[],
  registry: Registry,
  host: ProbeHost,
  options: ProbeOptions,
): Promise<ReturnType<typeof entryFor>[]> {
  const storage = new AsyncLocalStorage<string>();
  const captures = new Map<string, Capture[]>();
  const entries: ReturnType<typeof entryFor>[] = [];
  const queue = [...sources];

  async function worker(): Promise<void> {
    for (let source = queue.shift(); source; source = queue.shift()) {
      let probe: ReturnType<typeof entryFor>['probe'];
      if (SKIPPED_KINDS.has(source.kind)) {
        probe = { status: 'skipped', detail: null };
      } else {
        const name = source.name;
        let detail: string | null = null;
        try {
          const outcome = await storage.run(name, () =>
            withTimeout(registry.search(name, PROBE_QUERY, PROBE_LIMIT), options.timeoutMs),
          );
          if (outcome === TIMED_OUT) detail = 'timeout';
        } catch (error) {
          detail = probeDetail(error);
        }
        const seen = captures.get(name) ?? [];
        if (seen.length > 0) probe = { status: 'ok', detail };
        else probe = { status: 'failed', detail: detail ?? 'no request observed' };
      }
      const entry = entryFor(source, captures.get(source.name) ?? [], probe);
      entries.push(entry);
      host.log(
        `${entry.name.padEnd(20)} ${entry.route.padEnd(18)} ${entry.cors.padEnd(8)} ${entry.hosts.join(' ')}${
          entry.probe.detail ? `  (${entry.probe.detail})` : ''
        }`,
      );
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = recorder(host, storage, captures);
  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
    // One more attempt, one at a time, for every source that failed without a request: most
    // such failures are a timeout or a connection reset that a minute later does not recur, and a
    // flapping verdict would open a weekly pull request for nothing.
    const retry = entries.filter((entry) => entry.probe.status === 'failed');
    if (retry.length > 0) {
      host.log(`retrying ${String(retry.length)} failed source(s) once`);
      const byName = new Map(sources.map((source) => [source.name, source]));
      for (const failed of retry) {
        const source = byName.get(failed.name);
        if (!source) continue;
        captures.delete(source.name);
        queue.push(source);
        entries.splice(entries.indexOf(failed), 1);
        await worker();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return entries;
}

export async function runProbe(options: ProbeOptions, host: ProbeHost): Promise<number> {
  try {
    let prepared: { dir: string; commit: string };
    try {
      prepared = await host.prepare(options.ref);
    } catch (error) {
      host.log(`could not prepare ${UPSTREAM_REPO}@${options.ref}: ${probeDetail(error)}`);
      return 125;
    }
    host.log(`${UPSTREAM_REPO} at ${prepared.commit}`);

    let registry: Registry;
    let sources: UpstreamSource[];
    const restoreEnv = applyEnv({ set: {}, unset: [] });
    try {
      registry = await host.load(prepared.dir);
      sources = registry.list().filter((source) => !options.only || source.name === options.only);
    } catch (error) {
      restoreEnv();
      host.log(`could not load the registry: ${probeDetail(error)}`);
      return 125;
    }
    restoreEnv();
    if (options.only && sources.length === 0) {
      host.log(`no source named ${options.only}`);
      return 1;
    }
    host.log(`${String(sources.length)} sources to classify`);

    const restore = applyEnv(probeEnv(sources));
    let entries: ReturnType<typeof entryFor>[];
    try {
      entries = await probeAll(sources, registry, host, options);
    } finally {
      restore();
    }

    const file = buildSourcesFile(entries, { commit: prepared.commit });
    const text = renderSourcesFile(file);
    const counts = Object.entries(file.routes)
      .map(([route, count]) => `${route} ${String(count)}`)
      .join(', ');
    host.log(`routes: ${counts}`);

    const failed = entries.filter((entry) => entry.probe.status === 'failed').length;
    if (failed > options.maxFailed) {
      host.log(
        `${String(failed)} sources failed, more than --max-failed ${String(options.maxFailed)}: this run is not trusted and ${options.out} is left alone`,
      );
      return 2;
    }

    const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : '';
    if (options.check) {
      if (current === text) {
        host.log(`${options.out} matches the probe`);
        return 0;
      }
      host.log(`${options.out} differs from the probe:`);
      for (const line of describeDifference(current, file, text)) host.log(line);
      return 1;
    }
    if (current !== '' && current !== text) {
      host.log(`changes against ${options.out}:`);
      for (const line of describeDifference(current, file, text)) host.log(line);
    }
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, text);
    host.log(`wrote ${options.out} (${String(file.sources.length)} sources)`);
    return 0;
  } finally {
    host.cleanup();
  }
}

function run(command: string, args: string[], cwd: string): void {
  // npm is npm.cmd on Windows, which spawn only runs through a shell: hand cmd.exe the fixed
  // command line explicitly (no `shell: true`, so no argument-quoting deprecation either).
  const viaCmd = process.platform === 'win32' && command === 'npm';
  const result = viaCmd
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const tail = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-5).join('\n');
    const exit = result.status === null ? 'by signal' : String(result.status);
    throw new Error(`${command} ${args.join(' ')} exited ${exit}\n${tail}`);
  }
}

interface UpstreamRegistryModule {
  listSources(): UpstreamSource[];
  getAdapter(name: string): { search(query: string, limit: number): Promise<unknown[]> };
}

export function realHost(): ProbeHost {
  const originalFetch = globalThis.fetch;
  let dir: string | null = null;
  return {
    prepare(ref) {
      // Synchronous work behind a promise: git and npm block, and a throw here rejects the await.
      dir = mkdtempSync(join(tmpdir(), 'alexandria-probe-'));
      run('git', ['init', '--quiet'], dir);
      run('git', ['remote', 'add', 'origin', UPSTREAM_URL], dir);
      run('git', ['fetch', '--quiet', '--depth', '1', 'origin', ref], dir);
      run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
      const commit = head.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`could not resolve ${ref}`);
      run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], dir);
      return Promise.resolve({ dir, commit });
    },
    async load(cloneDir) {
      const registry = (await import(
        pathToFileURL(join(cloneDir, 'src/sources/registry.ts')).href
      )) as UpstreamRegistryModule;
      await import(pathToFileURL(join(cloneDir, 'src/sources/all.ts')).href);
      return {
        list: () => registry.listSources(),
        search: (name, query, limit) => registry.getAdapter(name).search(query, limit),
      };
    },
    fetch: originalFetch,
    log: (line) => {
      console.log(line);
    },
    cleanup() {
      if (!dir) return;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A file still open on Windows; the OS temp dir is cleaned eventually.
      }
    },
  };
}

if (import.meta.main) {
  let options: ProbeOptions;
  try {
    options = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  options.out = resolve(repoRoot, options.out);
  const code = await runProbe(options, realHost());
  // Upstream's modules keep handles open (stores, pools); exit instead of waiting on them.
  process.exit(code);
}
