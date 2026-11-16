/**
 * The org README images (P2-10): a banner and one card per listed project, rendered as
 * self-contained SVG from the same collection the pages use. GitHub proxies them through Camo,
 * so they carry no script, no external reference, no font or image fetch, and no build time
 * (the README links them by a content hash, which must only move when the content does).
 */

export const BANNER_SIZE = { width: 1200, height: 360 } as const;
export const CARD_SIZE = { width: 1200, height: 240 } as const;

export interface CardProject {
  name: string;
  slug: string;
  tagline: string;
  claim: { text: string; measured_on: string } | null;
  release: { tag: string; published_at: string } | null;
}

export interface BannerInput {
  /** Listed project names, in site order. */
  projects: string[];
}

const PAPER = '#fafaf7';
const INK = '#111111';
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MARGIN = 64;
const SITE = 'the40thieves.dev';

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Word-wrap `text` into at most `maxLines` lines of about `maxChars` characters; a word longer
 * than a line is cut, and a cut anywhere ends the last line with an ellipsis.
 */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let cut = false;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines) {
      cut = true;
      current = '';
      break;
    }
    if (word.length > maxChars) {
      lines.push(word.slice(0, maxChars));
      cut = true;
      current = '';
      break;
    }
    current = word;
  }
  if (current && lines.length < maxLines) lines.push(current);
  else if (current) cut = true;
  if (cut && lines.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] = `${last.replace(/[\s.,;:]+$/, '')}…`;
  }
  return lines;
}

/** Characters that fit in `width` pixels of sans text at `size`, by average glyph width. */
function charsFor(width: number, size: number): number {
  return Math.floor(width / (size * 0.52));
}

interface TextOptions {
  x: number;
  y: number;
  size: number;
  weight?: 600 | 400;
  opacity?: number;
  anchor?: 'start' | 'end';
}

function text(content: string, options: TextOptions): string {
  const attrs = [
    `x="${String(options.x)}"`,
    `y="${String(options.y)}"`,
    `font-size="${String(options.size)}"`,
    `font-weight="${String(options.weight ?? 400)}"`,
    `fill="${INK}"`,
  ];
  if (options.opacity !== undefined) attrs.push(`fill-opacity="${String(options.opacity)}"`);
  if (options.anchor === 'end') attrs.push('text-anchor="end"');
  return `<text ${attrs.join(' ')}>${escapeXml(content)}</text>`;
}

function open(width: number, height: number, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" ` +
    `viewBox="0 0 ${String(width)} ${String(height)}" role="img" ` +
    `font-family="${FONT}">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect width="${String(width)}" height="${String(height)}" fill="${PAPER}"/>` +
    `<rect x="${String(MARGIN)}" y="${String(MARGIN)}" width="6" height="${String(height - 2 * MARGIN)}" fill="${INK}"/>`
  );
}

export function bannerSvg(input: BannerInput): string {
  const { width, height } = BANNER_SIZE;
  const x = MARGIN + 40;
  const parts = [
    open(width, height, 'The 40 Thieves. Tools first.'),
    text('The 40 Thieves.', { x, y: 150, size: 72, weight: 600 }),
    text('Tools first.', { x, y: 230, size: 72, weight: 600, opacity: 0.55 }),
    text('Open-source developer tools, each with one measured claim and a one-line install.', {
      x,
      y: 282,
      size: 26,
      opacity: 0.8,
    }),
  ];
  const names = input.projects.join(' · ');
  if (names) parts.push(text(names, { x, y: 322, size: 22, opacity: 0.7 }));
  parts.push(text(SITE, { x: width - MARGIN, y: 322, size: 22, opacity: 0.7, anchor: 'end' }));
  parts.push('</svg>');
  return parts.join('');
}

export function cardSvg(project: CardProject): string {
  const { width, height } = CARD_SIZE;
  const x = MARGIN + 40;
  const usable = width - x - MARGIN;
  const parts = [open(width, height, `${project.name}: ${project.tagline}`)];
  parts.push(text(project.name, { x, y: 104, size: 44, weight: 600 }));
  if (project.release) {
    const release = `${project.release.tag} · ${project.release.published_at.slice(0, 10)}`;
    parts.push(
      text(`Latest ${release}`, {
        x: width - MARGIN,
        y: 104,
        size: 20,
        opacity: 0.7,
        anchor: 'end',
      }),
    );
  }
  const tagline = wrapLines(project.tagline, charsFor(usable, 24), 2);
  tagline.forEach((line, index) => {
    parts.push(text(line, { x, y: 146 + index * 32, size: 24, opacity: 0.85 }));
  });
  if (project.claim) {
    const claim = wrapLines(project.claim.text, charsFor(usable - 260, 18), 1)[0] ?? '';
    parts.push(
      text(`Measured ${project.claim.measured_on}: ${claim}`, {
        x,
        y: 212,
        size: 18,
        opacity: 0.65,
      }),
    );
  }
  parts.push(
    text(`${SITE}/${project.slug}/`, {
      x: width - MARGIN,
      y: 212,
      size: 18,
      opacity: 0.65,
      anchor: 'end',
    }),
  );
  parts.push('</svg>');
  return parts.join('');
}

const FORBIDDEN: { pattern: RegExp; detail: string }[] = [
  { pattern: /<script/i, detail: 'script element' },
  { pattern: /<foreignObject/i, detail: 'foreignObject element' },
  { pattern: /<image/i, detail: 'image element' },
  { pattern: /<style/i, detail: 'style element' },
  { pattern: /<a[\s>]/i, detail: 'anchor element' },
  { pattern: /<use[\s>]/i, detail: 'use element' },
  { pattern: /\shref\s*=/i, detail: 'href attribute' },
  { pattern: /xlink:href/i, detail: 'xlink:href attribute' },
  { pattern: /\son[a-z]+\s*=/i, detail: 'event handler attribute' },
  { pattern: /url\s*\(/i, detail: 'url() reference' },
  { pattern: /@import/i, detail: '@import' },
  { pattern: /https?:\/\/(?!www\.w3\.org\/2000\/svg")/i, detail: 'external URL' },
];

/** Everything in `svg` that would fetch, run or link; empty for a self-contained image. */
export function svgViolations(svg: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(svg)).map(({ detail }) => detail);
}
