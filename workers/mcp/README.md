# mcp

The Worker on `the40thieves.dev/mcp` (P3-S1): the public read-only MCP server for the hub.
No Access in front of it, no secrets inside it. Everything it serves is the manifest and the
Markdown twins in another shape, read from two KV documents the deploy uploads after every hub
build: `manifest.json` and `docs-index.json` (a MiniSearch index over the twins and `AGENTS.md`).

## Routes

| Route              | Method | Answer                                                                           |
| ------------------ | ------ | -------------------------------------------------------------------------------- |
| `/mcp`             | POST   | the MCP endpoint (Streamable HTTP, stateless, one `McpServer` per request)       |
| `/mcp/healthz`     | GET    | `{ "ok": true, "generated_at" }` once KV holds both documents, `503` before that |
| `/mcp/server-card` | GET    | the MCP Server Card (`application/mcp-server-card+json`), see below              |
| `/mcp/webmcp`      | GET    | the WebMCP page tool subset, `{ "enabled", "tools" }`, see below                 |
| `/mcp*` else       | any    | `404 { "error": "not found" }`                                                   |

Every response carries the `mcp` class of `security/headers.policy.json`, bundled at build time;
the deploy audits the live endpoint against the same file (`audit:headers --class mcp`).

## Server card

`/mcp/server-card` (P3-S3) is the Server Card of SEP-2127: what a client reads before it
connects. `src/card.ts` builds it from constants and the site origin, with no KV read, so it
answers while the data is loading. It carries `$schema`, `name`
(`io.github.The-40-Thieves/the40thieves-dev`), `version` (the server's own), `description`,
`websiteUrl` and one `remotes` entry: `streamable-http`, the `/mcp` URL and
`supportedProtocolVersions`, which is exactly what `server/discover` reports. It lists no tools.
`https://the40thieves.dev/.well-known/ai-catalog.json` (a static file in the hub) points at it.

- `GET` and `HEAD` answer `200` with a strong `ETag` derived from the body; a matching
  `If-None-Match` (weak comparison, lists and `*` included) answers `304`. `OPTIONS` is the CORS
  preflight (`204`); anything else is `405`.
- CORS for any origin and `Cache-Control: public, max-age=3600` are rules in the header policy
  scoped to the path. CORS goes on every response from the path; the cache header only on a `200`
  or `304`, so an error is never cached.
- The path shares the per-IP rate limit with `/mcp`.
- The schema is vendored at one upstream commit in `tests/fixtures/ext-server-card/` (repository
  root). `tests/server-card-schema.test.ts` pins its hash and validates the card;
  `tests/conformance.test.ts` compares the card with `server/discover`; the deploy smoke follows
  the live catalog to the live card and does the same.

## Page tools

`/mcp/webmcp` (P3-S4) is what a hub page reads before it registers WebMCP tools with the
browser. `src/webmcp.ts` runs the Worker's own `tools/list` in-process and keeps the names in
`WEBMCP_TOOL_NAMES` (`packages/manifest/src/webmcp.ts`): `search_projects`, `get_install` and
`read_doc`, each with the description and input schema the endpoint serves. A page tool is
therefore never defined twice; the page's `execute` is one same-origin `POST /mcp` built by
`pageRpcRequest`, the 2026-07-28 request that answers one JSON body. It resolves to the result's
`structuredContent`, and to `{ "isError": true, "message" }` for a failure the Worker explained,
because the browser serialises the value itself and reports a rejection only as "tool rejected".

- `GET` and `HEAD` answer `200 { "enabled": true, "tools": [...] }` with
  `Cache-Control: public, max-age=60` (a rule in the header policy scoped to the path). Other
  methods are `405`; an error (`503` while the data is loading or when the subset cannot be
  built) is never cached. No CORS: only the site's own pages read it.
- Kill switch: the KV key `webmcp-disabled` in `the40thieves-mcp`. While the key exists, with any
  value, the route answers `200 { "enabled": false, "tools": [] }` and no page registers a tool.
  It stops new registrations once KV has propagated the key (up to a minute) and the 60 second
  cache has run out, so allow two minutes; a tool already registered in an open tab keeps working
  until the tab reloads, and `/mcp` itself is unaffected.

  ```bash
  pnpm --filter @the40thieves/mcp exec wrangler kv key put webmcp-disabled 1 --binding MCP_KV --remote
  ```

  ```bash
  pnpm --filter @the40thieves/mcp exec wrangler kv key delete webmcp-disabled --binding MCP_KV --remote
  ```

- The path shares the per-IP rate limit with `/mcp`.
- Which page offers which tool is `webmcpToolsFor` in the manifest package; the `webmcp` contract
  surface fails the hub build when a page declares a tool outside the manifest or its route.
  `tests/webmcp.test.ts` covers the route, `tests/page-bridge.test.ts` pins the request a page
  sends, and the deploy smoke reads the live subset and makes one page-style call.

## Protocol versions

Built on `agents` `createMcpHandler` over `@modelcontextprotocol/server` 2.x. A 2026-07-28 client
starts with `server/discover`, which lists that revision; every exchange is one JSON body
(`responseMode: 'json'`). A 2025-11-25 client sends `initialize` and is served by the stateless
legacy lane (`legacy: 'stateless'`), where `GET` and `DELETE` are `405`. Both lanes list the same
tools; `tests/conformance.test.ts` proves it with the v2 client pinned to 2026-07-28 and with the
SDK v1 client.

## Tools

All nine come from `HUB_MCP_TOOLS` in `packages/manifest`, in `tools/list` order; the `mcp`
contract surface fails the hub build if the Worker served anything else. Every tool is
`readOnlyHint: true` with an output schema, and every result is `structuredContent` mirrored as
JSON text in `content` for clients that read only text.

| Tool               | Input                                       | Answer                                                                  |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------- |
| `search_projects`  | `query`, `limit?` (1..20), `cursor?`        | listed projects scored by name (3), tagline (2), description (1)        |
| `compare_projects` | `slugs` (2..5)                              | tagline, latest release, shell install and docs link side by side       |
| `get_project`      | `slug`                                      | the manifest project; release notes as `{ text, untrusted, truncated }` |
| `get_install`      | `slug`, `client`                            | the published snippet and its format (`shell` or `json`)                |
| `latest_release`   | `slug`                                      | tag, date, URL and the notes as untrusted text                          |
| `changelog_since`  | `slug?`, `version?`, `since?`               | releases newer by semver, posts since the date, `history: latest-only`  |
| `search_docs`      | `query`, `limit?`                           | twin paths with a snippet and a score, `untrusted: true`                |
| `read_doc`         | `path`, `cursor?`                           | one indexed twin, 20 kB a page, `untrusted: true`                       |
| `validate_config`  | `slug`, `client` (cursor, vscode), `config` | `valid`, every difference from the published snippet, `expected`        |

Arguments outside the input schema come back as an `isError` result naming the field; an
unknown slug, a path outside the index, a cursor the server did not issue, a version that is
not semver are `isError` with a message. Nothing throws through to the transport.

## Caps and limits

- 20 kB of structured JSON per page (`src/caps.ts`). Lists and `read_doc` text continue through
  `next_cursor`, a base64url `{"o":<offset>}`; `read_doc` cuts on a code point boundary.
- 100 requests per client IP per minute through the Rate Limiting binding (`429`,
  `Retry-After: 60`). A request without `cf-connecting-ip` counts against one shared `unknown`
  key rather than bypassing the limiter. `/mcp/healthz` is not limited; `/mcp/server-card` and
  `/mcp/webmcp` count against the same budget.
- Browser requests to `/mcp` must carry the site as `Origin`; MCP process clients send none and
  are accepted. `Host` must be the site. No CORS headers are sent there; only the server card is
  readable cross-origin.
- Release notes in the manifest are already cut at 8 kB by the hub build.

## Data

`src/data.ts` parses both documents once per isolate and re-reads KV after 60 seconds. A document
missing from KV or failing validation is a `DataError`: `/mcp/healthz` answers `503` and the deploy
loop keeps waiting; `/mcp` answers `503 { "error": "data not loaded" }`.

## Deploy

`deploy.yml`: the `deploy` job uploads `apps/hub/dist/client/manifest.json` and
`apps/hub/dist/client/mcp/docs-index.json` to KV `the40thieves-mcp` (`wrangler kv key put`), then
`deploy-mcp` deploys this Worker, waits for `/mcp/healthz`, audits the headers (the server card's
and the page tools' included) and runs `pnpm mcp:smoke --url https://the40thieves.dev`, which also
follows the AI Catalog to the card and reads and calls the page tool subset. The route `the40thieves.dev/mcp*` lives in
`wrangler.jsonc`; the hub's own prerendered `/mcp/docs-index.json` is never served live.

## Local run

```bash
pnpm --filter @the40thieves/mcp test
```

```bash
pnpm --filter @the40thieves/mcp typecheck
```

`wrangler dev` needs the KV documents. The stack script takes care of that: after a hub build,
`pnpm agent-stack` (from the repository root) seeds a throwaway local KV from
`apps/hub/dist/client/manifest.json` and `dist/client/mcp/docs-index.json`, starts this Worker and
the hub in local workerd, and serves both on `http://127.0.0.1:8790` with `/mcp*` routed here, as
the production route does. Nothing remote is read or written.

## Conformance

`pnpm conformance --local` (root) runs the agent-surface suite against that stack; CI runs it as
the job `conformance` on every pull request (P3-S5). For this Worker it checks, over HTTP and
with real clients: `server/discover`, `tools/list` and one call per tool under the page cap with
the SDK v2 client; connect, list and call with the SDK v1 package; a missing or mismatched
`MCP-Protocol-Version` (400); a foreign `Origin` (403); the AI Catalog, the Server Card and its
`ETag`; `/mcp/webmcp` and a page-style call; the manifest contract for the tool lists; and the
rate limit, exactly (100 pass, the 101st is a `429` with `Retry-After: 60`, another client and
`/mcp/healthz` are unaffected). `tests/conformance.test.ts` here runs the same row functions
against the Worker code in-process, so a behaviour change shows up in the unit run first. The
`Host` check is only tested in-process (`tests/handler.test.ts`): `wrangler dev` rewrites `Host`.
