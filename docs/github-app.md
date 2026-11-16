# GitHub App: the40thieves-bot

One App is the only non-human identity that acts on GitHub for the hub (P2-03). It replaces the per-job `github.token` for the content loader and will carry the rebuild dispatch (P2-09) and the org README commit (P2-10). Phase 8 adds user-to-server OAuth to the same App; the permission set below is deliberately minimal so that expansion shows up as a visible diff.

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Name, slug      | `the40thieves-bot`                                                                                                            |
| App ID          | 5593745 (public, stored as the repo secret `GH_APP_ID` for convenience)                                                       |
| Owner           | organization The-40-Thieves                                                                                                   |
| Created         | 2026-11-03 by the owner, in the browser                                                                                       |
| Installed on    | The-40-Thieves, "only select repositories": `the40thieves.dev` and `.github` (the deploy commits the org README there, P2-10) |
| Installation ID | 178154584 (discovered at run time by `findInstallationId`, never configured)                                                  |
| Webhook         | inactive; the rebuild path (P2-09) uses repository and Sanity webhooks on the Worker, not App events                          |
| Private key     | one key, `GH_APP_PRIVATE_KEY`; the downloaded `.pem` was deleted after `gh secret set`                                        |

## Permission matrix

| Permission | Level | Why                                                                                                                                                                          | Consumer                                                                                                                    |
| ---------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Metadata   | read  | mandatory for any installation                                                                                                                                               | all                                                                                                                         |
| Contents   | read  | the content loader reads public repositories over GraphQL (P2-04); public data needs no installation, but the App gives the build one identity and its own rate-limit budget | `ci.yml` jobs `check`, `build`, `preview`; `deploy.yml`                                                                     |
| Contents   | write | commit the generated org README to `.github` (P2-10); send `repository_dispatch` to `the40thieves.dev` (P2-09)                                                               | `deploy.yml` (README commit); `rebuild-dispatch` Worker (dispatch, token narrowed to `the40thieves.dev` and Contents write) |

Nothing else. No Issues, Pull requests, Actions, Workflows, Administration or organization permissions. The installation is limited to the two repositories the App must write to; everything else it reads is public.

## How the token is minted

- In CI the `check`, `build` and `preview` jobs and `deploy.yml` use `actions/create-github-app-token` (pinned by SHA) with `permission-contents: read` and `permission-metadata: read`, so even the installation's Contents write never reaches a build step.
- Our own helper lives in `packages/github` (`@the40thieves/github`): `appJwt` signs a nine-minute RS256 JWT, `findInstallationId` discovers the installation on the org, `mintInstallationToken` exchanges the JWT for a one-hour installation token, and `createInstallationTokenProvider` caches it for fifty minutes with a shared in-flight mint. It depends only on `node:crypto` and `fetch`, so the same code runs in the Worker under `nodejs_compat` (P2-09, P2-10).
- `scripts/github-app-check.ts` is the CI job `github-app`. It mints a token with the helper, masks it, and runs three checks: a GraphQL `viewer` query answers as the bot; `GET /installation/repositories` lists only `the40thieves.dev` and `.github`; and two side-effect-free write probes (delete a branch that does not exist) return 422 on the hub repository and 403 or 404 on `codecalc`. A 204 anywhere, or a 422 outside the installation, fails the job.

## Rotation

1. On the App's settings page, "Generate a private key". Two keys can coexist.
2. `gh secret set GH_APP_PRIVATE_KEY --repo The-40-Thieves/the40thieves.dev < <file>.pem`, then delete the file.
3. Re-run `ci.yml` on main; the `github-app` job proves the new key.
4. Delete the old key on the App's settings page.

The App ID never changes. If the App is ever reinstalled, the installation ID changes and nothing needs updating, since it is discovered at run time.

## Worker secrets

The rebuild Worker (P2-09, `workers/rebuild-dispatch`) holds `GH_APP_PRIVATE_KEY` as a Worker secret, pushed by `deploy.yml` from the repository secret on every deploy, and `GH_APP_ID` as a plain var in its `wrangler.jsonc`. It mints its installation tokens narrowed to `the40thieves.dev` with Contents write only (`scope` on `createInstallationTokenProvider`), so a token taken from the Worker could not touch `.github`.
