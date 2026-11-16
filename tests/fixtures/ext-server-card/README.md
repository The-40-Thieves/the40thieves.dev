# MCP Server Card schema (vendored)

Source: https://github.com/modelcontextprotocol/ext-server-card
Commit: 526201bbc80231daa40ffcdecfc9da4e54e5dc93 (2026-08-12)
License: Apache-2.0 (see `LICENSE`, copied from the same commit)

`schema.json` and the files under `valid/` and `invalid/` (upstream `examples/ServerCard/`) are
byte for byte the files at that commit. Do not edit or reformat them: `tests/server-card-schema.test.ts`
compares the SHA-256 of `schema.json` with the value in `tests/lib/server-card-schema.ts`.

P3-S3 gates the hub's own card (`/mcp/server-card`, built by `workers/mcp/src/card.ts`) on
this copy. To move the pin, download the files again at the new commit and update the commit here,
`SCHEMA_COMMIT` and `SCHEMA_SHA256` together:

    gh api "repos/modelcontextprotocol/ext-server-card/contents/schema.json?ref=<commit>" -H "Accept: application/vnd.github.raw" > schema.json
