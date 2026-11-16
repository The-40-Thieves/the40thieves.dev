import { expect, test } from 'vitest';

import { CLOUDINARY_IMAGE_BASE, imageUrl } from '../src/lib/cloudinary.ts';

test('imageUrl builds a delivery URL with automatic format and quality at the asked width', () => {
  expect(imageUrl('the40thieves/codecalc-0-13', 1200)).toBe(
    'https://res.cloudinary.com/dlju18kt4/image/upload/f_auto,q_auto,w_1200/the40thieves/codecalc-0-13',
  );
  expect(CLOUDINARY_IMAGE_BASE).toBe('https://res.cloudinary.com/dlju18kt4/image/upload/');
});

test('imageUrl refuses a public id that could escape the upload path or smuggle a transform', () => {
  for (const bad of ['../x', 'a b', 'x?y', 'x/../y', '', 'f_auto,q_auto/x']) {
    expect(() => imageUrl(bad, 800), bad).toThrow(/public_id/);
  }
});
