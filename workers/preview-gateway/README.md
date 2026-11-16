# preview-gateway

Serves the hub's pull request previews on `pr-<n>-preview.the40thieves.dev`.

The preview job in `ci.yml` uploads a hub version with `--preview-alias pr-<n>`. Cloudflare only
serves that alias on the account's workers.dev subdomain, and this repository never names that
subdomain: not in code, CI logs or PR comments. This Worker maps the public host to the alias and
proxies the request.

## Routing

- Route `*-preview.the40thieves.dev/*`, plus a proxied wildcard `AAAA 100::` record so the hosts
  resolve. Both are in `infra/cloudflare/the40thieves.dev.json`.
- `pr-<n>-preview` proxies to the alias. Any other `-preview` host is a `404`.
- A broader `*.the40thieves.dev/*` route was tried on 2026-11-16. It also took the traffic of the
  hooks and relay Custom Domains, so do not widen the pattern.

## Responses

- Redirects to the alias host come back on the public host. Redirects elsewhere pass through.
- Every response carries `X-Robots-Tag: noindex, nofollow`.
- `503` when the secret is missing or malformed. The body never echoes the secret.
- Request bodies are buffered before they are forwarded.

## Configuration

`PREVIEW_ORIGIN_SUFFIX` is a Worker secret of the form `-hub.<subdomain>.workers.dev`.
`deploy.yml` pushes it on every deploy from the `production` environment secret of the same name.
