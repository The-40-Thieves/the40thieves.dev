import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a lower-case slug');

/**
 * Portable Text as the Studio stores it. Only the envelope is pinned; the renderer reduces the
 * HTML it produces to the same allowlist as the release notes.
 */
export const portableTextSchema = z.array(
  z.object({ _type: z.string().min(1), _key: z.string().min(1).optional() }).loose(),
);

const editorial = {
  /** Sanity document id (published, never a `drafts.` id). */
  id: z.string().min(1),
  title: z.string().trim().min(1),
  slug,
  summary: z.string().trim().min(1),
  body: portableTextSchema.nullable(),
  /** Manifest project slug the entry is about, if any. */
  project: slug.nullable(),
  published_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
};

/** Where the spotlight title points; http(s) only, so a CMS value cannot become a javascript: href. */
const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * A Cloudinary public id: url-safe path segments and at most a final extension. No `..`, no
 * spaces, no commas, so it can only ever name a file under the cloud's upload path and never
 * smuggle a transform or a query into the delivery URL the site builds from it.
 */
export const cloudinaryPublicIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\.[A-Za-z0-9]+)?$/,
    'expected a Cloudinary public_id',
  );

const cloudinaryAsset = {
  public_id: cloudinaryPublicIdSchema,
  format: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
};

/** A spotlight image as the loader projects it: the Cloudinary asset plus the alt text an editor wrote. */
export const cloudinaryImageSchema = z
  .object({ ...cloudinaryAsset, alt: z.string().trim().min(1) })
  .strict();
export type CloudinaryImage = z.infer<typeof cloudinaryImageSchema>;

/** An image block inside a body. The asset is the whole `cloudinary.asset` the Studio stores. */
export const figureBlockSchema = z
  .object({
    _type: z.literal('figure'),
    _key: z.string().min(1),
    asset: z.object(cloudinaryAsset).loose(),
    alt: z.string().trim().min(1),
    caption: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type FigureBlock = z.infer<typeof figureBlockSchema>;

/** One Sanity `spotlight` document, projected by the loader's GROQ query (P2-11). */
export const spotlightSchema = z
  .object({ ...editorial, link: httpUrl.nullable(), image: cloudinaryImageSchema.nullable() })
  .strict();
export type Spotlight = z.infer<typeof spotlightSchema>;

/** One Sanity `changelogPost` document, projected by the loader's GROQ query (P2-11). */
export const changelogPostSchema = z.object(editorial).strict();
export type ChangelogPost = z.infer<typeof changelogPostSchema>;
