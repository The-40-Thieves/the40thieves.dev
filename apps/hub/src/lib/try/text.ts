/**
 * Small, dependency-free readers for the JSON and XML the try app's sources return. Every field
 * is checked before it is used: upstream shapes change, and a source that answers oddly should
 * drop the odd record, not crash the search.
 */

export type Json = Record<string, unknown>;

export function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A link a result may carry: an absolute `http:` or `https:` URL, or null. Upstream text is not
 * trusted, so a `javascript:`, `data:` or relative value never reaches an `href`.
 */
export function webUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** An id that may arrive as a number or a string. */
export function idText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
}

export function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{4}/.test(value)) return Number(value.slice(0, 4));
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the named entities above and numeric ones; anything else is left as written. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X'))
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Plain text from an HTML or JATS fragment: tags dropped, entities decoded, space collapsed. */
export function plain(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` characters, cut at a word boundary with an ellipsis. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Every `<tag>…</tag>` body in `xml`, in order (no nesting of the same tag is assumed). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

/** The first `<tag>` body in `xml`, as plain text, or ''. */
export function xmlText(xml: string, tag: string): string {
  const blocks = xmlBlocks(xml, tag);
  return blocks.length === 0 ? '' : plain(blocks[0]);
}
