# the40thieves.dev

Monorepo for [the40thieves.dev](https://the40thieves.dev), the public hub for The 40 Thieves, and the Cloudflare Workers that sit behind it.

## Layout

| Path              | What lives there                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/hub`        | The Astro 7 site, prerendered and served by the Cloudflare adapter as Worker `hub`                                                                                                                                    |
| `workers/`        | The other Workers: `rebuild-dispatch` (hooks.the40thieves.dev) and `mcp` (the public read-only MCP server on the40thieves.dev/mcp, its Server Card and the WebMCP page tool subset)                                   |
| `packages/`       | `schemas` (Zod schemas, the manifest), `manifest` (builder, contract surfaces, docs index), `github`, `config`                                                                                                        |
| `packages/config` | Shared `tsconfig`, ESLint and Prettier configuration (`@the40thieves/config`)                                                                                                                                         |
| `security/`       | `headers.policy.json` (the one source of truth for response headers) and `csp.directives.json`                                                                                                                        |
| `scripts/`        | `gen-headers.ts` (policy to `_headers`), `audit-headers.ts` (dist and live checks), `mcp-smoke.ts` (live MCP conformance), `agent-stack.ts` and `conformance.ts` (the agent-surface suite), `check-pinned-actions.ts` |
| `tests/`          | Vitest suites for the scripts and the workspace invariants                                                                                                                                                            |
| `.github/`        | `ci.yml` (pull requests and `workflow_call`), `deploy.yml` (push to `main`), Renovate, CODEOWNERS                                                                                                                     |
| `docs/`           | `github-app.md` (GitHub App), `relay-cost-model.md` (relay quota costs)                                                                                                                                               |

## Commands

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm test
```

`pnpm test` runs the root suites. The hub's build-output test needs a build first: `pnpm build && pnpm --filter hub test`. Other root scripts: `lint`, `format:check`, `typecheck`, `gen:headers`, `audit:headers`, `check:actions`.

### Agent-surface conformance

```bash
pnpm build && pnpm conformance --local --browser --report conformance-report
```

This is what the CI job `conformance` runs. It starts the hub and the `mcp` Worker in local workerd on one origin (`http://127.0.0.1:8790`, ports 8790 to 8792; nothing remote, no credentials), checks every surface an agent reads (the MCP endpoint with both SDK generations, the caps, the rate limit, the version header, the Server Card, the AI Catalog, the Markdown twins, the manifest contract and the page tools in Chromium) and writes `conformance-report/report.md` and `report.json`. Each check is one row: `pass`, `fail` or `skip`, with what was seen. Failed rows are listed first; any of them makes the command exit 1. `--browser` needs Playwright's Chromium (`pnpm --filter hub exec playwright install chromium`); leave the flag out to skip that row.

`pnpm conformance --url https://the40thieves.dev` runs the same checks against a site that is already up. The rate-limit burst is only ever sent to a local stack; against a remote URL it is a `skip` row. `pnpm agent-stack` starts the stack alone and keeps it up for manual requests until it is interrupted. The stack takes five ports in a row (8790 to 8794 by default: the origin, the two Workers and an inspector port for each) and will not start while one of them is taken (a stack from an earlier run, usually): stop that one first (`pnpm agent-stack` also takes `--port`).

### Linux check

```bash
pnpm build && pnpm check:linux
```

CI runs on ubuntu and a development machine may not. This runs the checks that start processes (the root tests, the hub tests, the conformance suite with `--browser` and the Playwright specs) in a throwaway Linux box on [instabox](https://instabox.sh/docs), so a difference that only shows on Linux (port binding, process groups, the browser's system libraries) is found before a push. It needs the `instabox` CLI, signed in. A run takes about a minute and prints one line per step, with the last lines of any step that failed; the exit code is 1 if a check failed, 125 if the box could not be made ready (not created, an upload or an install failed), 2 if there is no build.

What goes to the box is the tracked files of the checkout as they are on disk (`git add` a new file first) and the `apps/hub/dist` built here. The box does not build, lint or typecheck: those need a GitHub token, and no credential goes into the box (it is created with no vault and no secrets). So this does not cover a build that only breaks on Linux; the CI `build` job does.

The box is deleted when the run ends, and the server deletes it after 30 minutes if the run is interrupted. `--keep` leaves it up to look around (`instabox ssh <name>`; the command prints the name and how to delete it).

The box starts from instabox's default template and installs what it lacks: the Node major in `.nvmrc` (checked against the published SHA-256), the pnpm in `packageManager`, the dependencies from the lockfile and Playwright's Chromium. That is about 20 s of the run, and it means the check depends on nothing stored in an account. `--snapshot <name>` starts from a snapshot that already holds the toolchain instead; it is not the default because it measured no faster (58 s against 53 s on 2026-11-09, and 113 s the first time the snapshot was fetched): what the box skips installing, it spends being created.

### Source probe

```bash
pnpm probe:sources
```

Writes `data/sources.json` (P4-S1): one entry per alexandria-mcp source with the route a browser on this site takes to it. The script clones `The-40-Thieves/alexandria-mcp` at `main` (or `--ref`) into a temp directory, runs `npm ci` there, imports its source registry in-process and searches each REST and RSS source once with a placeholder in place of every key, recording the hosts it called and their CORS answers (one `OPTIONS` preflight per host that saw a non-simple header). A run takes a minute or two and needs network. No URL, query or key value is written; the file has no timestamp, so an unchanged world gives an unchanged file. A write over an existing file first logs one line per source that changed. `pnpm check:sources` re-probes and exits 1 with those lines, leaving the file alone. More than 25 failed sources (`--max-failed`) means the network, not the world, changed: nothing is written and the exit is 2. `--only <name>` probes one source and needs `--out <file>`, so a one-source file never lands on the committed one.

The four routes: `browser-direct` (CORS allows the hub origin; a key, when wanted, is the visitor's and stays in the browser), `visitor-key-relay` (the host does not allow the origin, so the request goes through the relay, with the visitor's key when there is one), `quota-relay` (same, for a keyed source with a daily cap, so the relay holds an operator key) and `mcp-only` (remote MCP servers and scraped sites, which only alexandria-mcp itself serves). A source whose search made no request for the probe's query stays `cors: unknown` and takes the relay. The matrix renders at `/alexandria/sources/` (Markdown twin, JSON and JSON Schema beside it).

The workflow `sources-probe` re-runs the probe every Monday (and on dispatch) and, when the file changes, pushes `bot/sources-probe` as the App and opens a pull request against `main`. Nothing merges by itself.

## Toolchain

Node 26 (`.nvmrc`), pnpm 12.15.0 (`packageManager`, no Corepack). Dependencies are pinned exact and resolved under a seven-day minimum release age (`pnpm-workspace.yaml`).
