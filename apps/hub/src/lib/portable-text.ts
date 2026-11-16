import { figureBlockSchema } from '@the40thieves/schemas';
import { escapeHTML, toHTML, type PortableTextHtmlComponents } from '@portabletext/to-html';
import type { PortableTextBlock } from '@portabletext/types';
import { z } from 'zod';

import { imageUrl } from './cloudinary.ts';
import { sanitize } from './markdown.ts';

/** Widest the content column renders an image, at 2x for dense screens. */
const FIGURE_WIDTH = 1200;

function figure(value: unknown): string {
  const parsed = figureBlockSchema.safeParse(value);
  if (!parsed.success) {
    const key = (value as { _key?: unknown } | null)?._key;
    throw new Error(
      `figure ${typeof key === 'string' ? key : '?'} is not renderable\n${z.prettifyError(parsed.error)}`,
    );
  }
  const { asset, alt, caption } = parsed.data;
  const size =
    asset.width !== null && asset.height !== null
      ? ` width="${String(asset.width)}" height="${String(asset.height)}"`
      : '';
  const img = `<img src="${imageUrl(asset.public_id, FIGURE_WIDTH)}" alt="${escapeHTML(alt)}"${size} loading="lazy">`;
  const figcaption = caption ? `<figcaption>${escapeHTML(caption)}</figcaption>` : '';
  return `<figure>${img}${figcaption}</figure>`;
}

// Unknown block or mark types render nothing rather than the library's hidden placeholder div.
const components: Partial<PortableTextHtmlComponents> = {
  types: { figure: ({ value }) => figure(value) },
  unknownType: () => '',
  unknownMark: ({ children }) => children,
  unknownBlockStyle: ({ children }) => `<p>${children ?? ''}</p>`,
};

/**
 * Portable Text from the Sanity dataset to sanitised HTML. Editors are trusted people, but the
 * output still goes through the same allowlist as release notes (plus Cloudinary images), so a
 * pasted script, a `javascript:` link or an image from elsewhere cannot reach a page.
 */
export function renderPortableText(blocks: readonly unknown[] | null): string {
  if (!blocks || blocks.length === 0) return '';
  return sanitize(toHTML(blocks as PortableTextBlock[], { components }), { images: true });
}
