import { expect, test } from 'vitest';

import { renderReleaseNotes, sanitize } from '../src/lib/markdown.ts';

test('renderReleaseNotes renders GitHub-flavoured markdown to HTML', () => {
  const html = renderReleaseNotes('## Changes\n\n- **fast** path\n- [docs](https://example.com/d)');
  expect(html).toContain('<h2>Changes</h2>');
  expect(html).toContain('<strong>fast</strong>');
  expect(html).toContain('<a href="https://example.com/d"');
});

test('renderReleaseNotes strips scripts, handlers and javascript: links', () => {
  const html = renderReleaseNotes(
    'Hi <script>alert(1)</script><img src=x onerror="alert(1)"> <a href="javascript:alert(1)">x</a>\n\n<iframe src="https://evil"></iframe>',
  );
  expect(html).not.toContain('<script');
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<iframe');
  expect(html).toContain('Hi');
});

test('renderReleaseNotes returns an empty string for missing notes', () => {
  expect(renderReleaseNotes(null)).toBe('');
  expect(renderReleaseNotes('   ')).toBe('');
});
const cloudinaryImg =
  '<img src="https://res.cloudinary.com/dlju18kt4/image/upload/f_auto/the40thieves/x" alt="x" />';

test('release notes never carry images, even from Cloudinary', () => {
  expect(renderReleaseNotes(`Hi ${cloudinaryImg}`)).toBe('<p>Hi </p>');
});

test('editorial sanitising keeps a Cloudinary image and drops every other host', () => {
  expect(sanitize(cloudinaryImg, { images: true })).toBe(cloudinaryImg);
  expect(sanitize('<img src="https://evil.example/x.png" alt="x" />', { images: true })).toBe('');
  expect(
    sanitize('<img src="https://res.cloudinary.com/other-cloud/image/upload/x" alt="x" />', {
      images: true,
    }),
  ).toBe('');
  expect(sanitize('<img src="data:image/png;base64,AAAA" alt="x" />', { images: true })).toBe('');
});

test('renderReleaseNotes marks every link rel=noopener', () => {
  const html = renderReleaseNotes('[docs](https://example.com/d)');
  expect(html).toBe('<p><a href="https://example.com/d" rel="noopener">docs</a></p>');
});
