import { expect, test } from 'vitest';

import { renderPortableText } from '../src/lib/portable-text.ts';

const link = { _type: 'link', _key: 'l1', href: 'https://example.com/x' };
const block = (
  style: string,
  children: { text: string; marks?: string[] }[],
  markDefs = [link],
) => ({
  _type: 'block',
  _key: `k-${style}`,
  style,
  markDefs,
  children: children.map((child, i) => ({
    _type: 'span',
    _key: `s${String(i)}`,
    text: child.text,
    marks: child.marks ?? [],
  })),
});

test('paragraphs, headings, marks and links render as plain HTML', () => {
  const html = renderPortableText([
    block('h2', [{ text: 'What changed' }]),
    block('normal', [
      { text: 'A ' },
      { text: 'measured', marks: ['strong'] },
      { text: ' claim on the ' },
      { text: 'repo', marks: ['l1'] },
      { text: '.' },
    ]),
  ]);
  expect(html).toBe(
    '<h2>What changed</h2><p>A <strong>measured</strong> claim on the ' +
      '<a href="https://example.com/x" rel="noopener">repo</a>.</p>',
  );
});

test('an h1 in the body is capped to h2 and scripts or inline handlers never survive', () => {
  const html = renderPortableText([
    block('h1', [{ text: 'Top' }]),
    block('normal', [{ text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }]),
  ]);
  expect(html).toBe(
    '<h2>Top</h2><p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</p>',
  );
});

test('a javascript: link is dropped while its text stays', () => {
  const html = renderPortableText([
    block('normal', [{ text: 'click', marks: ['l1'] }], [{ ...link, href: 'javascript:alert(1)' }]),
  ]);
  expect(html).toBe('<p>click</p>');
});

const figure = {
  _type: 'figure',
  _key: 'f1',
  asset: { public_id: 'the40thieves/org-readme', format: 'png', width: 1600, height: 900 },
  alt: 'The org README with the banner and three cards',
  caption: 'Rendered by the deploy.',
};

test('a figure block renders a lazy Cloudinary image with its alt and caption', () => {
  expect(renderPortableText([figure])).toBe(
    '<figure><img src="https://res.cloudinary.com/dlju18kt4/image/upload/f_auto,q_auto,w_1200/the40thieves/org-readme" ' +
      'alt="The org README with the banner and three cards" width="1600" height="900" loading="lazy" />' +
      '<figcaption>Rendered by the deploy.</figcaption></figure>',
  );
});

test('a figure without a caption renders no figcaption', () => {
  const bare = { _type: figure._type, _key: figure._key, asset: figure.asset, alt: figure.alt };
  expect(renderPortableText([bare])).not.toContain('<figcaption');
  expect(renderPortableText([bare])).toContain('<img src="https://res.cloudinary.com/');
});

test('a figure missing alt text or a valid asset fails the build naming the block', () => {
  expect(() => renderPortableText([{ ...figure, alt: '' }])).toThrow(/figure f1[\s\S]*alt/);
  expect(() =>
    renderPortableText([{ ...figure, asset: { ...figure.asset, public_id: '../x' } }]),
  ).toThrow(/figure f1[\s\S]*public_id/);
});

test('null or empty input renders an empty string', () => {
  expect(renderPortableText(null)).toBe('');
  expect(renderPortableText([])).toBe('');
});
