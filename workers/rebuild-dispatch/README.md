# rebuild-dispatch

The Worker behind `hooks.the40thieves.dev` (P2-09). A verified GitHub or Sanity webhook
becomes one `repository_dispatch` of type `rebuild` on `The-40-Thieves/the40thieves.dev`, which
`deploy.yml` already listens for. Nothing else can start a rebuild.

## Routes

| Route      | Sender         | Signature                                                                           | Replay key          |
| ---------- | -------------- | ----------------------------------------------------------------------------------- | ------------------- |
| `/github`  | org webhook    | `X-Hub-Signature-256`, HMAC-SHA256 of the raw body                                  | `X-GitHub-Delivery` |
| `/sanity`  | Sanity webhook | `sanity-webhook-signature`, `t=<ms>,v1=<HMAC of "<ms>.<body>">`, five-minute window | `idempotency-key`   |
| `/healthz` | anyone         | none                                                                                |                     |

Responses: `202 {"status":"dispatched"|"coalesced"}`, `204` for a verified event the filter
drops, `401` for a bad or stale signature (logged without the body), `409` for a delivery id seen
in the last 24 hours, `413` over 1 MiB, `500` when a secret is missing, `502` when GitHub refused
the dispatch (the delivery id is released so a redelivery can try again).

## What rebuilds

GitHub: `release` with action `published` (not draft, not prerelease), `push` to the
repository's default branch, `repository` with action `publicized`. Sanity: `create`, `update`
or `delete` of a published document in the `the40thieves` dataset. Everything else is a `204`
before any work happens; in particular every push to a feature branch across the org is dropped
by the filter.

## Debounce

The first trigger dispatches at once and takes a 60-second lock in KV. Triggers that arrive while
the lock stands are parked (last one wins); a cron every minute dispatches the parked trigger once
the lock has expired. Ten pushes in a minute therefore cost one build now and one trailing build.
KV is eventually consistent, so a race across colos can at worst add one extra build.

## Owner setup

Done on 2026-11-04 (org webhook 707505920, Sanity webhook `bKPvV1bvPTygARxv`). The steps stay as the
rotation procedure: a new secret goes to the Worker (`wrangler secret put`), to the GitHub environment
and to the webhook, in that order, so no delivery is refused in between.

Before the branch merges (the deploy job pushes these to the Worker):

1. Generate the two webhook secrets, never pasting them anywhere but the two stores below:

   ```bash
   openssl rand -hex 32 | gh secret set REBUILD_GITHUB_WEBHOOK_SECRET --env production --repo The-40-Thieves/the40thieves.dev
   ```

   ```bash
   openssl rand -hex 32 | gh secret set REBUILD_SANITY_WEBHOOK_SECRET --env production --repo The-40-Thieves/the40thieves.dev
   ```

   Keep each value available once more for the webhook form (for example `gh secret set` from a
   file you then delete), or generate it into a password manager entry first.

After the first deploy:

2. Org webhook (O-4): GitHub, organization settings, Webhooks, Add webhook. Payload URL
   `https://hooks.the40thieves.dev/github`, content type `application/json`, secret = the GitHub
   value from step 1, events: Releases, Pushes, Repositories. The `gh` path needs the
   `admin:org_hook` scope (`gh auth refresh -h github.com -s admin:org_hook`).
3. Sanity webhook: sanity.io/manage, project `cfnvp6ru`, API, Webhooks, Create. URL
   `https://hooks.the40thieves.dev/sanity`, dataset `the40thieves`, trigger on create, update and
   delete, filter `_type in ["spotlight", "changelogPost", "page"]`, drafts excluded, projection
   `{_id, _type}`, HTTP method POST, secret = the Sanity value from step 1.
4. The custom domain and the Worker route are new edge state: run `pnpm edge-config:export` and
   commit `infra/cloudflare/the40thieves.dev.json`, or the drift gate fails on the next run.
5. Check: `curl -fsS https://hooks.the40thieves.dev/healthz` answers `{"ok":true}`; a
   redelivery from the org webhook's "Recent deliveries" shows `202`; the hub deploy run that
   follows names the trigger in its `repository_dispatch` payload.

If the production deploy token is refused on the KV binding, add "Workers KV Storage: Edit" to
the token `the40thieves.dev production deploy`.

## Development

```bash
pnpm --filter @the40thieves/rebuild-dispatch test
```

```bash
pnpm --filter @the40thieves/rebuild-dispatch typecheck
```

The tests run under Node against an in-memory store; `wrangler dev` (`pnpm --filter
@the40thieves/rebuild-dispatch preview`) runs the Worker locally with a local KV.
