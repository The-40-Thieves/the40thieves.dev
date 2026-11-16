/** The structured payload of one tool page stays under this many JSON bytes (P3-S1). */
export const MAX_PAGE_BYTES = 20_000;

/** A `cursor` argument the server did not issue; tools answer it with `isError`. */
export class CursorError extends Error {
  override readonly name = 'CursorError';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes of `value` as JSON, the size every cap counts. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return decoder.decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Cursors are base64url of `{"o":<offset>}`: opaque to clients, trivially inspectable by us. */
export function encodeCursor(offset: number): string {
  return toBase64Url(JSON.stringify({ o: offset }));
}

/** The offset a cursor names; `undefined` is the first page. Anything else is a `CursorError`. */
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const text = fromBase64Url(cursor);
  let parsed: unknown;
  try {
    parsed = text === null ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CursorError('cursor is not one this server issued');
  }
  const offset = (parsed as { o?: unknown }).o;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new CursorError('cursor is not one this server issued');
  }
  return offset;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * The items from `cursor` on whose JSON array stays under `limit` bytes, and a cursor for the
 * rest. An item larger than the limit still goes out alone, so a page is never empty before
 * the end.
 */
export function page<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit = MAX_PAGE_BYTES,
): Page<T> {
  const offset = decodeCursor(cursor);
  if (offset > items.length) {
    throw new CursorError(`cursor is past the end (${String(offset)} of ${String(items.length)})`);
  }
  const out: T[] = [];
  let size = 2;
  for (let i = offset; i < items.length; i++) {
    const item = items[i] as T;
    const next = size + jsonBytes(item) + (out.length > 0 ? 1 : 0);
    if (next > limit && out.length > 0) break;
    out.push(item);
    size = next;
  }
  const end = offset + out.length;
  return { items: out, next_cursor: end < items.length ? encodeCursor(end) : null };
}

/** Bytes one code point takes inside a JSON string: escapes for the few JSON escapes, UTF-8 else. */
function jsonCharBytes(codePoint: number): number {
  if (codePoint < 0x20)
    return codePoint === 0x0a || codePoint === 0x09 || codePoint === 0x0d ? 2 : 6;
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export interface TextPage {
  text: string;
  next_cursor: string | null;
}

/**
 * The slice of `text` from `cursor` on whose JSON encoding stays under `limit` bytes, cut on a
 * code point boundary (never inside a surrogate pair). Offsets are UTF-16 code units of `text`.
 */
export function sliceText(
  text: string,
  cursor: string | undefined,
  limit = MAX_PAGE_BYTES,
): TextPage {
  const offset = decodeCursor(cursor);
  if (offset > text.length) {
    throw new CursorError(`cursor is past the end (${String(offset)} of ${String(text.length)})`);
  }
  let end = offset;
  let size = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end) ?? 0;
    const bytes = jsonCharBytes(codePoint);
    if (size + bytes > limit && end > offset) break;
    size += bytes;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return {
    text: text.slice(offset, end),
    next_cursor: end < text.length ? encodeCursor(end) : null,
  };
}
