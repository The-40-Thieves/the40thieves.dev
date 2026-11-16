import { cloudinaryPublicIdSchema } from '@the40thieves/schemas';

/** The 13th Letter's Cloudinary cloud. Delivery URLs are public, so the name is not a secret. */
export const CLOUDINARY_CLOUD_NAME = 'dlju18kt4';

/** Every image the site shows from Cloudinary starts with this; the sanitiser and the CSP pin it. */
export const CLOUDINARY_IMAGE_BASE = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/`;

/**
 * Delivery URL for a public id: automatic format and quality, resized to `width`. The id is
 * validated here as well as in the schema, so a value that reached this far by another route
 * still cannot change the path.
 */
export function imageUrl(publicId: string, width: number): string {
  const parsed = cloudinaryPublicIdSchema.safeParse(publicId);
  if (!parsed.success) {
    throw new Error(`not a Cloudinary public_id: ${JSON.stringify(publicId)}`);
  }
  return `${CLOUDINARY_IMAGE_BASE}f_auto,q_auto,w_${String(width)}/${parsed.data}`;
}
