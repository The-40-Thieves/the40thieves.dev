import { expect, test } from 'vitest';

import {
  CursorError,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_BYTES,
  page,
  sliceText,
} from '../src/caps.ts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const b64url = (text: string) =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('cursors are base64url of {"o":offset} and round-trip', () => {
  expect(encodeCursor(0)).toBe(b64url('{"o":0}'));
  expect(decodeCursor(undefined)).toBe(0);
  expect(decodeCursor(encodeCursor(42))).toBe(42);
});

test('a cursor the server did not issue is a CursorError, never a silent first page', () => {
  for (const bad of [
    'zzz',
    '',
    'e30',
    b64url('{"o":-1}'),
    b64url('{"o":"1"}'),
    b64url('{"o":1.5}'),
    b64url('[1]'),
  ]) {
    expect(() => decodeCursor(bad), bad).toThrow(CursorError);
  }
});

test('page keeps the JSON of the items under the limit and continues from where it stopped', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
  const first = page(items, undefined, 1000);
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(50);
  expect(bytes(first.items)).toBeLessThanOrEqual(1000);
  expect(first.next_cursor).not.toBeNull();
  const walked = [...first.items];
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const next = page(items, cursor, 1000);
    expect(bytes(next.items)).toBeLessThanOrEqual(1000);
    walked.push(...next.items);
    cursor = next.next_cursor;
  }
  expect(walked).toEqual(items);
});

test('page returns everything with a null cursor when it fits, and one item even when it does not', () => {
  expect(page([1, 2, 3], undefined)).toEqual({ items: [1, 2, 3], next_cursor: null });
  expect(page([], undefined)).toEqual({ items: [], next_cursor: null });
  const huge = [{ pad: 'x'.repeat(MAX_PAGE_BYTES * 2) }, { pad: 'y' }];
  const first = page(huge, undefined);
  expect(first.items).toHaveLength(1);
  expect(first.next_cursor).not.toBeNull();
  expect(page(huge, first.next_cursor ?? undefined)).toEqual({
    items: [{ pad: 'y' }],
    next_cursor: null,
  });
});

test('page rejects a cursor past the end', () => {
  expect(() => page([1, 2], encodeCursor(3))).toThrow(CursorError);
  expect(page([1, 2], encodeCursor(2))).toEqual({ items: [], next_cursor: null });
});

test('sliceText cuts on a character boundary under the byte limit and walks the whole text', () => {
  const text = 'héllo wörld '.repeat(3000);
  const first = sliceText(text, undefined, 1000);
  expect(new TextEncoder().encode(first.text).length).toBeLessThanOrEqual(1000);
  expect(first.text.length).toBeGreaterThan(0);
  expect(first.next_cursor).not.toBeNull();
  let out = first.text;
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const next = sliceText(text, cursor, 1000);
    out += next.text;
    cursor = next.next_cursor;
  }
  expect(out).toBe(text);
});

test('sliceText never splits a surrogate pair', () => {
  const text = '😀'.repeat(1000);
  const first = sliceText(text, undefined, 101);
  expect(first.text.length % 2).toBe(0);
  expect(/^(?:😀)+$/u.test(first.text)).toBe(true);
  expect(new TextEncoder().encode(first.text).length).toBeLessThanOrEqual(101);
});

test('sliceText returns the whole text with a null cursor when it fits', () => {
  expect(sliceText('short', undefined)).toEqual({ text: 'short', next_cursor: null });
  expect(() => sliceText('short', encodeCursor(6))).toThrow(CursorError);
});
