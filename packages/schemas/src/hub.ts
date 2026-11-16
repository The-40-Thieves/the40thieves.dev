import { z } from 'zod';

/** Words that mark copy nobody measured or wrote yet. A match fails the build. */
export const PLACEHOLDER_PATTERN = /\b(todo|tbd|placeholder|lorem|ipsum|xxx|fixme)\b/i;

const noPlaceholder = (field: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((text) => !PLACEHOLDER_PATTERN.test(text), {
      message: `${field} reads like a placeholder; ship real copy or omit the file`,
    });

/** Install snippets per client. Keys are the clients the product page renders, in this order. */
export const INSTALL_CLIENTS = ['shell', 'claude-code', 'cursor', 'vscode'] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

export const installSchema = z
  .object({
    shell: z.string().trim().min(1).optional(),
    'claude-code': z.string().trim().min(1).optional(),
    cursor: z.string().trim().min(1).optional(),
    vscode: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((install) => INSTALL_CLIENTS.some((client) => install[client] !== undefined), {
    message: 'install needs at least one client snippet (shell, claude-code, cursor, vscode)',
  });

/**
 * `hub.json`: what a repository tells the hub about itself. Lives at the repo root, or, until
 * the repo carries one, at `apps/hub/content/hub/<repo>.json` in the hub repo.
 */
export const hubJsonSchema = z
  .object({
    tagline: noPlaceholder('tagline').pipe(z.string().max(160)),
    claim: z
      .object({
        text: noPlaceholder('claim.text').pipe(z.string().max(200)),
        /** Where the number can be checked. https only. */
        source: z.url({ protocol: /^https$/ }),
        measured_on: z.iso.date(),
      })
      .strict(),
    install: installSchema,
    /** Repo-relative docs directory, when the project has docs. */
    docs: z.string().trim().min(1).optional(),
    /**
     * True once the repository publishes `docs` to the hub through the org's `docs-deploy`
     * workflow (P2-07): the product page then links to `/<slug>/docs/` and the manifest
     * carries the docs URL. The repository tree stays the link until then.
     */
    docs_site: z.boolean().default(false),
    /**
     * Where the project's published documentation lives when it is not on the hub's own
     * `/<slug>/docs/` path, such as the docs hub at `docs.the40thieves.dev`. https only. When
     * set it is the documentation link and the manifest's docs URL, ahead of `docs_site`.
     */
    docs_url: z
      .url({ protocol: /^https$/ })
      .optional()
      .describe(
        'https URL of documentation published outside the hub. When set it is the documentation link and takes precedence over docs_site.',
      ),
    /** Listed projects get a product page and a place on the home page. */
    listed: z.boolean().default(false),
  })
  .strict();

export type HubJson = z.infer<typeof hubJsonSchema>;
export type HubJsonInput = z.input<typeof hubJsonSchema>;

/** Where the hub publishes the JSON Schema below; a repo's `hub.json` may point at it. */
export const HUB_SCHEMA_ID = 'https://the40thieves.dev/schemas/hub.json';

/** Keys a `hub.json` may carry for editors and readers; the loader drops them before validation. */
export const HUB_META_KEYS = ['$schema', '$comment'] as const;

/**
 * The JSON Schema (draft 2020-12) a repository validates its `hub.json` against. Generated from
 * the zod schema in input mode (so defaulted fields such as `listed` stay optional, as the loader
 * accepts them), with `$schema` and `$comment` allowed on top so editors can link this document.
 */
export function hubJsonSchemaDocument(): Record<string, unknown> {
  const generated = z.toJSONSchema(hubJsonSchema, { target: 'draft-2020-12', io: 'input' });
  const properties = (generated['properties'] ?? {}) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: HUB_SCHEMA_ID,
    title: 'hub.json',
    description:
      'What a repository tells the hub at the40thieves.dev about itself: tagline, one measured claim with its source and date, install snippets per client, docs path, whether the docs are published on the hub (docs_site), or the URL of docs published elsewhere (docs_url, which takes precedence over docs_site).',
    ...generated,
    properties: {
      $schema: { type: 'string', description: `Optional; ${HUB_SCHEMA_ID}` },
      $comment: { type: 'string', description: 'Optional; free text for maintainers' },
      ...properties,
    },
  };
}
