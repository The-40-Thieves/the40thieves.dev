import { expect, test } from 'vitest';

import {
  BANNER_SIZE,
  CARD_SIZE,
  bannerSvg,
  cardSvg,
  escapeXml,
  svgViolations,
  wrapLines,
  type CardProject,
} from '../src/lib/og-cards.ts';

const codecalc: CardProject = {
  name: 'codecalc',
  slug: 'codecalc',
  tagline:
    'A calculator, a code runner and a logic checker for AI agents: 51 MCP tools across 31 languages, sandboxed in Rust, no LLM in the loop.',
  claim: {
    text: '51 MCP tools across 31 language runtimes, enforced against the README by check_claims.py in CI.',
    measured_on: '2026-11-02',
  },
  release: { tag: 'v0.13.0', published_at: '2026-09-21T23:44:00Z' },
};

test('escapeXml escapes the five XML characters and nothing else', () => {
  expect(escapeXml(`a < b & c > "d" 'e'`)).toBe(
    'a &lt; b &amp; c &gt; &quot;d&quot; &apos;e&apos;',
  );
  expect(escapeXml('plain')).toBe('plain');
});

test('wrapLines wraps at word boundaries, caps the line count and marks the cut', () => {
  expect(wrapLines('one two three four', 9, 3)).toEqual(['one two', 'three', 'four']);
  expect(wrapLines('one two three four five', 9, 2)).toEqual(['one two', 'three…']);
  expect(wrapLines('', 9, 2)).toEqual([]);
  expect(wrapLines('supercalifragilistic', 5, 2)).toEqual(['super…']);
});

test('the banner carries the hub copy, the listed project names and the brand sizes', () => {
  const svg = bannerSvg({ projects: ['codecalc', 'alexandria-mcp', 'audio-forge'] });
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg).toContain(`width="${String(BANNER_SIZE.width)}"`);
  expect(svg).toContain(`height="${String(BANNER_SIZE.height)}"`);
  expect(svg).toContain('The 40 Thieves.');
  expect(svg).toContain('Tools first.');
  expect(svg).toContain('one measured claim');
  expect(svg).toContain('codecalc · alexandria-mcp · audio-forge');
  expect(svg).toContain('#fafaf7');
  expect(svg).toContain('#111111');
  expect(svg).toContain('<title>');
});

test('a project card carries name, tagline, claim with its date, release and the page URL', () => {
  const svg = cardSvg(codecalc);
  expect(svg).toContain(`width="${String(CARD_SIZE.width)}"`);
  expect(svg).toContain('>codecalc<');
  expect(svg).toContain('A calculator, a code runner and a logic checker for AI agents');
  expect(svg).toContain('Measured 2026-11-02');
  expect(svg).toContain('v0.13.0');
  expect(svg).toContain('2026-09-21');
  expect(svg).toContain('the40thieves.dev/codecalc/');
  // The build time never enters a card, so its hash only moves when its content does.
  expect(cardSvg(codecalc)).toBe(svg);
});

test('a card without a release or a claim omits those lines instead of printing null', () => {
  const svg = cardSvg({ ...codecalc, claim: null, release: null });
  expect(svg).not.toContain('null');
  expect(svg).not.toContain('Measured');
  expect(svg).not.toContain('Latest');
});

test('text is escaped, so a tagline with markup cannot inject elements', () => {
  const svg = cardSvg({ ...codecalc, tagline: 'x <script>alert(1)</script> & y' });
  expect(svg).not.toContain('<script>');
  expect(svg).toContain('&lt;script&gt;');
  expect(svgViolations(svg)).toEqual([]);
});

test('svgViolations flags scripts, external references, images, styles imports and foreignObject', () => {
  expect(svgViolations(bannerSvg({ projects: [] }))).toEqual([]);
  expect(svgViolations(cardSvg(codecalc))).toEqual([]);
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://x.test/">x</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://x.test/#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(x)</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>',
  ];
  for (const svg of bad) expect(svgViolations(svg), svg).not.toEqual([]);
});
test('svgViolations is not fooled by whitespace before the equals sign or the parenthesis', () => {
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><a href = "https://x.test/">x</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick = "1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url (#g)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect\nhref\t=\n"x"/></svg>',
  ];
  for (const svg of bad) expect(svgViolations(svg), svg).not.toEqual([]);
});
