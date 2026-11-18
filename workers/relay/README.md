# relay

The Worker on `relay.the40thieves.dev` (P4-S2). It forwards one browser request at a time from
the page at `https://the40thieves.dev` to a research source whose API refuses cross-origin calls, so
a visitor can search that source with their own API key. It is a narrow pipe, not an open proxy:

- only the hosts of the `visitor-key-relay` entries in `data/sources.json` are reachable;
- only the browser origin `https://the40thieves.dev` may call it;
- every relayed request needs a session, and a session needs a solved Turnstile challenge;
- it never follows a redirect, never returns more than 2 MB, never runs longer than 20 s;
- it never stores a visitor key and never writes a URL, query string or header value to a log.

What it refuses: any other origin or no origin, any host off the allowlist (including the same host
on another port, with userinfo, over `http` or as an IP literal), any host whose DNS answer contains
a private, reserved or special-use address, any upstream redirect, any request without a valid
session, and anything over the rate limits or size caps below. The browser app and the Turnstile
widget (P4-S4) and the kill switch (P4-S5) are not here.

It also runs the quota relay (P4-S3, `/v1/quota/<source>`): for the three keyed sources in the
`quota-relay` entries of `data/sources.json` (courtlistener, guardian, ucdp), it calls the source
with the operator's own key, under a daily budget per source and per visitor, so a visitor can search
them without a key of their own. The cost model and dashboard query are in
`docs/relay-cost-model.md`.

## Request contract

The machine-readable contract is `openapi.json` (the CI ZAP scan reads it).

### `POST /v1/session`

Body `{ "token": "<Turnstile widget response token>" }`, at most 4096 bytes, from the allowed
origin. Answers `200 { "session": "<token>", "expires_at": <epoch seconds> }`. The session is a
stateless signed token (`v1.<exp>.<HMAC-SHA-256>` keyed by `RELAY_SESSION_SECRET`). It is a bearer
token: whoever holds it can use it, for 3600 s, from any client address, since it is not bound to
the visitor's IP. Nothing records issued sessions, so one cannot be revoked by itself; the only way
to end live sessions early is to rotate `RELAY_SESSION_SECRET`, which ends all of them. Check order: origin, method (`POST` only), rate limit
(5 per IP per 60 s), body cap, then the token with Cloudflare siteverify (which must report the
hostname `the40thieves.dev`).

### `GET | HEAD | POST /v1/fetch`

Request headers:

| Header            | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `X-Relay-Target`  | The absolute `https` URL to call upstream, at most 4096 characters, no port, no userinfo |
| `X-Relay-Session` | The `session` from `/v1/session`                                                         |

The upstream URL travels in a header, not in the relay's own URL, so a key in its query string never
appears in the relay's request line. The visitor's other headers (`Authorization`, an API-key
header, `Accept`, a JSON `Content-Type`) pass upstream untouched; `Cookie`, `Origin`, `Referer`,
`User-Agent`, hop-by-hop headers and every `cf-`, `sec-`, `x-forwarded-`, `proxy-` and `x-relay-`
header, plus `True-Client-IP` and `CDN-Loop`, are dropped. The upstream status passes through as is
(a status outside 200 to 599 is `upstream_failed`); of its headers the relay passes on only
`content-type`, `etag`, `last-modified`, `retry-after` and `x-ratelimit-*`, beside the `relay`
class of `security/headers.policy.json` and `cache-control: no-store`. Cross-origin page script can
read only `content-type`, `etag`, `last-modified` and `retry-after` (the
`Access-Control-Expose-Headers` list in `src/handler.ts`, besides the CORS-safelisted response
headers); the upstream's `x-ratelimit-*` headers are passed through but not exposed to script yet.

Check order, first failure answers:

1. `OPTIONS` from the allowed origin is the CORS preflight (`204`, max age 600 s).
2. Origin: exactly `https://the40thieves.dev`.
3. Method: `GET`, `HEAD` or `POST`.
4. Target: a well-formed `X-Relay-Target`, then its hostname on the allowlist. Both are decided
   before anything is awaited, so an off-list host is refused without any network contact.
5. Session: present, well formed, correctly signed and not expired.
6. Rate limit: 60 per IP per 60 s.
7. Request body: at most 64 KiB (`POST` only).
8. DNS: the host is resolved over Cloudflare DNS-over-HTTPS; every address must be public.
9. Forward: no redirects, the 2 MB response cap and the 20 s deadline.

### `GET | HEAD /v1/quota/<source>`

`<source>` is `courtlistener`, `guardian` or `ucdp`. Same headers as `/v1/fetch`, but the target's
hostname must be that source's one host (`www.courtlistener.com`, `content.guardianapis.com`,
`ucdpapi.pcr.uu.se`), and there is no body. The relay removes the visitor's `Authorization` and adds
the operator key the way the source takes it: `Authorization: Token <key>` for courtlistener, the
`api-key` query parameter for guardian (replacing any the visitor sent), and `x-ucdp-access-token`
for ucdp. The relayed answer carries `X-Quota-Remaining`, the requests this visitor can still make
to this source today, exposed to page script.

Check order, first failure answers:

1. `OPTIONS` from the allowed origin is the CORS preflight (`GET, HEAD`).
2. Origin: exactly `https://the40thieves.dev`.
3. Method: `GET` or `HEAD`.
4. Quota relay configured at all (otherwise `503 not_configured`), then a known source (otherwise
   `404 not_found`).
5. Target: well formed, and its hostname is the source's host. Decided before anything is awaited.
6. Operator key: set for this source (otherwise `503 not_configured`).
7. Session, then the rate limit (the same 60 per IP per 60 s budget as `/v1/fetch`).
8. DNS, as for `/v1/fetch`.
9. Budget: one request of the source's site budget and of this visitor's budget for the UTC day is
   reserved, or `429 quota_reached` with `Retry-After` set to the seconds until the next UTC
   midnight. A refused request spends nothing.
10. Forward, as for `/v1/fetch`.

Budgets: the site cap is 80% of the upstream's declared daily cap (100, 360 and 3,600 requests);
the visitor caps are 10, 30 and 100. Both reset at UTC midnight. The counters live in one
SQLite-backed Durable Object per source (`QuotaCounter`, `src/quota-counter.ts`), so a cap is exact.
A visitor is a keyed HMAC of the day and the client IP, truncated to 12 bytes: no IP is stored, and
the key changes every day. A reserved request counts even if the upstream then fails.

### `GET | HEAD /v1/healthz`

`200 { "ok": true, "hosts": <allowlist size>, "configured": <both secrets set>, "quota": [<sources
with an operator key>], "paused": <kill switch on> }`. No origin check, no log line. Any other path
is `404 not_found`.

### Errors

Every error body is `{ "error": "<code>" }`, with the policy headers. Codes and statuses, from
`ERROR_CODES` in `src/handler.ts`:

| Code                 | Status | When                                                                            |
| -------------------- | ------ | ------------------------------------------------------------------------------- |
| `origin_not_allowed` | 403    | No `Origin`, or not `https://the40thieves.dev`                                  |
| `method_not_allowed` | 405    | A method the route does not take (with `Allow`)                                 |
| `bad_target`         | 400    | `X-Relay-Target` missing, too long, not absolute `https`, or with port/userinfo |
| `host_not_allowed`   | 403    | The target's hostname is not on the allowlist                                   |
| `session_required`   | 401    | No `X-Relay-Session`                                                            |
| `session_invalid`    | 401    | A session that is malformed, forged or expired                                  |
| `rate_limited`       | 429    | Over 60 fetches or 5 sessions per IP per 60 s (with `Retry-After: 60`)          |
| `quota_reached`      | 429    | The source's site or visitor budget for the UTC day is spent (`Retry-After`)    |
| `body_too_large`     | 413    | A fetch body over 64 KiB, or a session body over 4096 bytes                     |
| `dns_blocked`        | 502    | DNS failed, gave no address, or gave a private or special-use address           |
| `upstream_redirect`  | 502    | The upstream answered with a redirect                                           |
| `upstream_too_large` | 502    | The upstream declared a body over 2 MB                                          |
| `upstream_timeout`   | 504    | No upstream answer within the 20 s deadline                                     |
| `upstream_failed`    | 502    | The upstream fetch failed                                                       |
| `turnstile_failed`   | 403    | No token, or siteverify did not pass it for `the40thieves.dev`                  |
| `not_found`          | 404    | Any other path, or an unknown quota source                                      |
| `not_configured`     | 503    | A relay secret is unset (all but healthz), or a quota source has no key         |
| `paused`             | 503    | The kill switch is on (with `Retry-After: 300`); see "Kill switch"              |

A body that goes over 2 MB or past the deadline after the upstream status was already sent cannot
change status any more: the stream is cut with an error, and the log line records `too_large` or
`timeout`.

## Limits

| Limit                | Value                                                       | Where                                  |
| -------------------- | ----------------------------------------------------------- | -------------------------------------- |
| Response body        | 2 MB (`2 * 1024 * 1024` bytes), declared or streamed        | `RESPONSE_CAP_BYTES`, `src/forward.ts` |
| Fetch request body   | 64 KiB (`64 * 1024` bytes)                                  | `REQUEST_CAP_BYTES`, `src/handler.ts`  |
| Session request body | 4096 bytes                                                  | `src/handler.ts`                       |
| Deadline             | 20 s from the upstream fetch starting to the last byte sent | `DEADLINE_MS`, `src/forward.ts`        |
| Session lifetime     | 3600 s                                                      | `src/session.ts`                       |
| `/v1/fetch` rate     | 60 per IP per 60 s (Rate Limiting namespace `1002`)         | `wrangler.jsonc`                       |
| `/v1/session` rate   | 5 per IP per 60 s (Rate Limiting namespace `1003`)          | `wrangler.jsonc`                       |
| DNS verdict cache    | 300 s per isolate (30 s for a failed lookup)                | `src/resolve.ts`                       |
| Quota, site per day  | 80% of upstream's cap: 100, 360, 3,600                      | `SITE_SHARE`, `src/quota.ts`           |
| Quota, visitor a day | 10, 30, 100 (courtlistener, guardian, ucdp)                 | `src/quota.ts`                         |

## Logging

One JSON line per `/v1/session`, `/v1/fetch`, `/v1/quota` and unknown-path request (`src/log.ts`, the only
`console` call in the Worker): time, route, outcome (an error code, `minted`, or for a relayed body
`complete`, `too_large`, `timeout` or `failed`), status, the allowlisted upstream hostname, the body
bytes passed on and the duration. Preflights and healthz write nothing.

A `/v1/quota` request that passes the session and rate-limit checks also writes one data point to
the Analytics Engine dataset `relay_quota` (preflights and earlier refusals write none):
source, outcome and status only. That is the cost dashboard (`docs/relay-cost-model.md`).

Never logged: the target URL, its path or query string, any header value (so no `Authorization`, API
key or cookie), the session token, the Turnstile token and the client IP. The platform's own
per-request invocation log, which would carry the request URL, is switched off in `wrangler.jsonc`
(`observability.logs.invocation_logs: false`), and so is automatic tracing, which would record
each fetch URL and query string (`observability.traces.enabled: false`). The upstream fetch is made
with `cache: 'no-store'`, which bypasses Cloudflare's cache for upstreams not hosted on Cloudflare,
so the relay's own zone never stores or replays an upstream answer. An upstream that is itself on
Cloudflare is cached, or not, under its own zone's rules, as it would be for a direct request from
the browser.

## Local development

- `pnpm --filter @the40thieves/relay test` runs the unit tests and the allowlist gate (`tests/`,
  every network dependency faked); `pnpm --filter @the40thieves/relay typecheck` type-checks.
- `pnpm relay-stack [--port 8795]` runs the production handler in local workerd
  (`wrangler.stack.jsonc`, entry `tests/stack-entry.ts`) with a mock upstream on loopback as its only
  allowed host (`upstream.test`), prints a session and `ready`, and stays up until interrupted.
  Nothing it does reaches a real host or Cloudflare. Its secrets are test values committed in
  `tests/stack-deps.ts` (Cloudflare's always-pass Turnstile test secret, its dummy token
  `XXXX.DUMMY.TOKEN.XXXX` and a literal session key) and are worth nothing anywhere else.
- The `relay-zap` CI job runs a ZAP active API scan from `openapi.json` against that stack and fails
  on any High alert, or when the scan did not get past the checks to the mock upstream. `deploy.yml`
  needs the whole `ci` workflow, so on main a red `relay-zap` stops every deploy.

## Deploy

The `deploy-relay` job in `.github/workflows/deploy.yml` deploys on every push to main and on every
rebuild dispatch (`repository_dispatch: rebuild`), once `ci` is green. It first fails, naming the missing secret and printing no value, when `TURNSTILE_SECRET_KEY`
or `RELAY_SESSION_SECRET` is empty in the GitHub `production` environment: an unconfigured relay
answers 503 to everything, which is not a finished deploy. Then `wrangler deploy` with both secrets
pushed from the environment (`wrangler secret bulk`, values never on a command line), and these
checks against `https://relay.the40thieves.dev` only:

- `/v1/healthz` answers and reports `configured: true` (12 attempts, 10 s apart);
- `pnpm audit:headers --class relay` on `/v1/healthz` and `/v1/nope` (404);
- four refusals, matched exactly: `/v1/fetch` without `Origin` is 403 `origin_not_allowed`; with
  the site origin and target `https://evil.test/` is 403 `host_not_allowed`; with an allowlisted
  target and no session is 401 `session_required`; `POST /v1/session` with token `x` is 403
  `turnstile_failed`. None of them is forwarded to a source.

`wrangler.jsonc` declares `relay.the40thieves.dev` as a Custom Domain, so the first deploy creates
its DNS record and certificate with the existing production token, and the relay becomes a public
endpoint from that moment. The record then needs adding to the edge-config export
(`infra/cloudflare/the40thieves.dev.json`) in a follow-up pull request; until that merges the
`edge-config` drift check fails, as it did for `hooks`.

The quota relay's operator keys come from `RELAY_OPERATOR_KEYS` in the same environment, a JSON
object of source name to key, for example `{"courtlistener":"…","guardian":"…","ucdp":"…"}`. It is
optional: when it is set, the job pushes it to the Worker as `OPERATOR_KEYS` after the deploy
(`wrangler secret put`, read from stdin), after checking it is a JSON object with a non-empty key
for at least one known source (otherwise the job fails and pushes nothing). When it is not set, the
job removes any `OPERATOR_KEYS` already on the Worker and says so, and every quota source answers
`not_configured`. A source missing from the object, or with an empty value, is not
configured on its own. The keys are free accounts the owner registers: CourtListener (sign-up at
courtlistener.com), the Guardian Open Platform (developer key) and UCDP (token by email to the UCDP
API maintainers, see ucdp.uu.se/apidocs).

What the first deploy needs, both in place since 2026-11-10:

1. A Turnstile widget named `the40thieves.dev relay`, mode Managed, hostname `the40thieves.dev`.
   The sitekey is public and goes into P4-S4; the secret went straight into the GitHub
   `production` environment as `TURNSTILE_SECRET_KEY`.
2. `RELAY_SESSION_SECRET` (32 random bytes, hex), generated straight into the same environment,
   never displayed. Changing it ends every live session at once.

## Kill switch

One key in the `FLAGS` KV namespace pauses the relay and the `/alexandria/try/` page together
(P4-S5). The rule lives in `security/pause-flag.ts`, which both Workers import.

| To     | Do                                                                         |
| ------ | -------------------------------------------------------------------------- |
| Pause  | Write any value to the key `relay-paused` (a short reason is a good value) |
| Resume | Delete the key `relay-paused`                                              |
| Check  | `GET https://relay.the40thieves.dev/v1/healthz` and read `paused`          |

```sh
pnpm --filter @the40thieves/relay exec wrangler kv key put relay-paused "abuse, see runbook" --binding FLAGS --remote
pnpm --filter @the40thieves/relay exec wrangler kv key delete relay-paused --binding FLAGS --remote
```

If the Cloudflare login can see more than one account, wrangler refuses to choose: set
`CLOUDFLARE_ACCOUNT_ID` to the account that runs the relay first. The same key can be written or
deleted in the dashboard, under Storage & Databases, Workers KV, `the40thieves-flags`.

While paused:

- `/v1/session`, `/v1/fetch` and `/v1/quota/<source>` answer `503 { "error": "paused" }` with
  `Retry-After: 300`. Nothing is verified with Turnstile, no session is minted, no budget is
  spent and nothing goes upstream. The checks that need no lookup (origin, method, target and
  allowlist) still answer first, so an off-list host is still `403 host_not_allowed`.
- Preflights and `/v1/healthz` answer as usual; healthz reports `"paused": true`.
- `https://the40thieves.dev/alexandria/try/` answers a static page with status 503 and
  `Retry-After: 300`. The page has no script, so the app does not load. Its web manifest, its icon
  and its Markdown twin are still served.

Each Worker reads the key with a 30 second cache, the shortest Workers KV allows, so a write
takes effect everywhere within about 30 seconds. The values `0`, `false`, `off` and `no` count as
not paused, so a mistaken "turn it off" write does not pause the site; deleting the key is the
resume. If a read fails, a Worker keeps the last value it saw (not paused before its first
successful read) and reports the failure: a KV outage neither pauses nor resumes the site.

The deploy job skips its live refusal probes while the relay is paused and says so in a warning.

## Honest limitations

1. The primary control is the host allowlist. Private-address protection behind it is the DoH
   check, which is defence in depth, not a guarantee: the Worker's own `fetch` resolves the name
   again, so there is a DNS rebinding window between the check and the request. The target parser
   also refuses IP-literal targets, since no IP literal is on the allowlist. The
   `global_fetch_strictly_public` flag is not a private-address filter: it makes a fetch to a
   Cloudflare zone, this Worker's own included, go through that zone's public front door and
   security settings instead of straight to its origin.
2. The allowlist is the set of hosts of the `visitor-key-relay` entries in `data/sources.json`,
   fixed at build time. A change to that file reaches the relay only through a reviewed merge and a
   deploy; the weekly probe pull request does not change the live relay by itself.
3. The CI ZAP scan does not fuzz the `X-Relay-Target` or `X-Relay-Session` headers; it fuzzes the
   query and body inputs only. Those two headers are covered by the unit tests and the allowlist
   gate in `tests/`.
4. A visitor's API key passes through the relay in request headers. It is never stored and never
   logged, but the relay does see it in transit.
5. Quota budgets are counted per IP, so visitors behind one address (an office, a carrier NAT) share
   one visitor budget, and one person with many addresses gets many. The site cap still bounds the
   total. A reserved request counts even if the upstream then fails or times out.
6. The guardian key travels in the upstream URL's query string, as the Guardian requires. The relay
   never logs that URL, the platform invocation log and tracing are off, and redirects are refused,
   so the key goes only to `content.guardianapis.com`.
