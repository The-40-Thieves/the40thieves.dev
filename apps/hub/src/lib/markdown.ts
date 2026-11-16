import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

import { CLOUDINARY_IMAGE_BASE } from './cloudinary.ts';

// Release notes come from GitHub releases, which anyone with push access to a repo can edit, so
// the rendered HTML is reduced to a strict allowlist before it reaches a page or the feed.
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h2',
    'h3',
    'h4',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  allowedAttributes: { a: ['href', 'rel'], td: ['align'], th: ['align'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  transformTags: {
    // Headings in notes sit under the page's own h2, so cap them one level down.
    h1: 'h2',
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener' }),
  },
  disallowedTagsMode: 'discard',
};

// Editorial bodies may carry images, but only ones the site built from a Cloudinary public id:
// an <img> from any other origin, or with a data: URL, is dropped whole rather than left empty.
const EDITORIAL: sanitizeHtml.IOptions = {
  ...SANITIZE,
  allowedTags: [...(SANITIZE.allowedTags as string[]), 'figure', 'figcaption', 'img'],
  allowedAttributes: {
    ...SANITIZE.allowedAttributes,
    img: ['src', 'alt', 'width', 'height', 'loading'],
  },
  exclusiveFilter: (frame) =>
    frame.tag === 'img' && !(frame.attribs['src'] ?? '').startsWith(CLOUDINARY_IMAGE_BASE),
};

export interface SanitizeOptions {
  /** Allow Cloudinary images (editorial content). Release notes never set this. */
  images?: boolean;
}

/** Untrusted HTML reduced to the allowlist above; shared with the Portable Text renderer. */
export function sanitize(html: string, options: SanitizeOptions = {}): string {
  return sanitizeHtml(html, options.images ? EDITORIAL : SANITIZE).trim();
}

/** GitHub-flavoured markdown to sanitised HTML; empty input yields an empty string. */
export function renderReleaseNotes(markdown: string | null): string {
  if (!markdown || markdown.trim() === '') return '';
  const html = marked.parse(markdown, { gfm: true, breaks: false, async: false });
  return sanitize(html);
}
