import { z } from 'zod';

/**
 * `data/design-library.json`: the design, motion and graphics resource library rendered at
 * `/design/library/`. Every row records whether the resource may ship in commercial work, under
 * which licence, and what the last verification pass changed. A human pass re-fetches every link
 * and re-reads every licence; `verified` is the date of that pass.
 */

/** What a reader may do with the resource in paid work. Exactly one per item. */
export const DESIGN_USES = [
  // An open licence, or terms that allow commercial use without a notable condition.
  'clear',
  // Commercial use is allowed with a condition worth knowing first: a paid tier, a size cap,
  // copyleft, a Commons Clause or attribution. The item's `note` names it.
  'conditions',
  // Reference or inspiration only; no reuse rights are granted.
  'study',
] as const;
export type DesignUse = (typeof DESIGN_USES)[number];

/** `bot-wall`: the host refuses scripted requests, so the link was confirmed through a browser fetch. */
export const DESIGN_CHECKS = ['ok', 'bot-wall'] as const;
export type DesignCheck = (typeof DESIGN_CHECKS)[number];

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a category id is lowercase letters, digits or -');
const textOrNull = z.string().trim().min(1).nullable();

export const designCategorySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    intro: z.string().trim().min(1),
  })
  .strict();

export const designItemSchema = z
  .object({
    title: z.string().trim().min(1),
    url: z.url({ protocol: /^https$/ }),
    category: idSchema,
    blurb: textOrNull,
    use: z.enum(DESIGN_USES),
    licence: textOrNull,
    /** The terms or licence page that was read, when it is not the item's own URL. */
    terms: z.url({ protocol: /^https$/ }).nullable(),
    note: textOrNull,
    check: z.enum(DESIGN_CHECKS),
  })
  .strict();

export const DESIGN_LIBRARY_SCHEMA_ID = 'https://the40thieves.dev/schemas/design-library.json';

export const designLibrarySchema = z
  .object({
    $schema: z.literal(DESIGN_LIBRARY_SCHEMA_ID),
    version: z.literal(1),
    verified: z.iso.date(),
    categories: z.array(designCategorySchema).min(1),
    items: z.array(designItemSchema),
    /** Items the last pass dropped, kept so the change is visible. */
    removed: z.array(
      z
        .object({ title: z.string().trim().min(1), url: z.url(), reason: z.string().trim().min(1) })
        .strict(),
    ),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.categories.map((category) => category.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'category ids must be unique',
      });
    }
    const known = new Set(ids);
    const urls = new Set<string>();
    file.items.forEach((item, i) => {
      if (!known.has(item.category)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'category'],
          message: `unknown category ${item.category}`,
        });
      }
      const key = item.url.replace(/\/$/, '').toLowerCase();
      if (urls.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'url'],
          message: `duplicate url ${item.url}`,
        });
      }
      urls.add(key);
      if (item.use === 'conditions' && item.note === null && item.licence === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i],
          message: `${item.title} has conditions but neither a licence nor a note naming them`,
        });
      }
    });
  });

export type DesignCategory = z.infer<typeof designCategorySchema>;
export type DesignItem = z.infer<typeof designItemSchema>;
export type DesignLibrary = z.infer<typeof designLibrarySchema>;

/** The JSON Schema served at `/schemas/design-library.json`. */
export function designLibraryJsonSchemaDocument(): Record<string, unknown> {
  const generated = z.toJSONSchema(designLibrarySchema, { target: 'draft-2020-12' });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: DESIGN_LIBRARY_SCHEMA_ID,
    title: 'the40thieves.dev design-library.json',
    description:
      'Design, motion and graphics resources, each with a commercial-use status (clear, conditions or study), its licence, the terms page read and the verification date.',
    ...generated,
  };
}
