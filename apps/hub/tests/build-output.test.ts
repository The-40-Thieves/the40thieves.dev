import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { svgViolations } from '../src/lib/og-cards.ts';
import { activeTrialTokens } from '../src/lib/origin-trials.ts';

// The Cloudflare adapter writes the deployable site to dist/client (dist/server stays empty
// while every page is prerendered).
const dist = 'dist/client';
const html = () => readFileSync(`${dist}/index.html`, 'utf8');

test('built home page carries a hashed CSP meta and no unsafe-inline script-src', () => {
  const meta = /<meta http-equiv="content-security-policy" content="([^"]+)"/i.exec(html())?.[1];
  expect(meta).toBeDefined();
  expect(meta).not.toContain("'unsafe-inline'");
  expect(meta).toContain("default-src 'self'");
  expect(meta).toContain("object-src 'none'");
});

test('built home page carries the hub copy and the three project links', () => {
  const page = html();
  expect(page).toContain('The 40 Thieves. Tools first.');
  for (const name of ['codecalc', 'alexandria-mcp', 'audio-forge']) {
    expect(page).toContain(`https://github.com/The-40-Thieves/${name}`);
  }
});

test('build ships 404.html, _headers and the well-known files', () => {
  for (const file of [
    '404.html',
    '_headers',
    '.well-known/security.txt',
    '.well-known/ai-catalog.json',
    'robots.txt',
    'llms.txt',
    'schemas/hub.json',
    'schemas/sources.json',
    'alexandria/sources/index.html',
    'alexandria/sources.md',
    'alexandria/sources.json',
    'alexandria/try/index.html',
    'alexandria/try.md',
    'alexandria/try/manifest.webmanifest',
    'schemas/design-library.json',
    'design/library/index.html',
    'design/library.md',
    'design/library.json',
  ]) {
    expect(existsSync(`${dist}/${file}`), file).toBe(true);
  }
});

test('build ships no source map anywhere under dist and the Worker never uploads them', () => {
  // P2-12 source-map leak gate: maps go to Sentry from the deploy job and are deleted there;
  // nothing under dist/ may carry one, and wrangler must not upload maps to Cloudflare either.
  const maps: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.map')) maps.push(path);
    }
  };
  walk('dist');
  expect(maps).toEqual([]);
  // The adapter copies wrangler.jsonc into the deploy config wrangler reads; both must say no.
  const deployConfig = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8')) as {
    upload_source_maps?: boolean;
  };
  expect(deployConfig.upload_source_maps).toBe(false);
  expect(readFileSync('wrangler.jsonc', 'utf8')).toMatch(/"upload_source_maps":\s*false/);
});

test('build serves only dist/client and keeps the generated wrangler.json out of it', () => {
  // With the on-demand /healthz route the adapter writes its deploy config next to the server
  // bundle (dist/server), pointing the assets binding back at dist/client, so nothing from the
  // server build (chunks, maps, config) is ever an asset.
  const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8')) as {
    main?: string;
    assets?: { directory?: string };
    vars?: Record<string, string>;
  };
  expect(config.assets?.directory).toBe('../client');
  expect(config.vars?.['SENTRY_DSN']).toMatch(
    /^https:\/\/[0-9a-f]+@o\d+\.ingest\.us\.sentry\.io\/\d+$/,
  );
  expect(existsSync(`${dist}/wrangler.json`)).toBe(false);
  expect(readFileSync(`${dist}/.assetsignore`, 'utf8')).toContain('wrangler.json');
});

test('build emits a product page per listed project with JSON-LD SoftwareSourceCode', () => {
  for (const slug of ['codecalc', 'alexandria-mcp', 'audio-forge']) {
    expect(existsSync(`${dist}/${slug}/index.html`), slug).toBe(true);
  }
  const page = readFileSync(`${dist}/codecalc/index.html`, 'utf8');
  const ld = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(page)?.[1];
  expect(ld).toBeDefined();
  const data = JSON.parse(ld ?? '{}') as { '@type'?: string; codeRepository?: string };
  expect(data['@type']).toBe('SoftwareSourceCode');
  expect(data.codeRepository).toBe('https://github.com/The-40-Thieves/codecalc');
  expect(page).toContain('claude mcp add codecalc');
  expect(page).toContain('data-copy');
});

test('the CSP allows this Cloudinary cloud and every built image comes from it or the site', () => {
  // CI builds against the live dataset, which may hold no spotlight or figure at all, so this
  // pins the invariant rather than the fixture: whatever images the pages carry, none loads from
  // anywhere else (the fixture build exercises the hero and figure markup locally).
  const meta = /<meta http-equiv="content-security-policy" content="([^"]+)"/i.exec(html())?.[1];
  expect(meta).toMatch(/img-src [^;]*https:\/\/res\.cloudinary\.com\/dlju18kt4\//);
  for (const page of ['index.html', 'changelog/index.html']) {
    const markup = readFileSync(`${dist}/${page}`, 'utf8');
    for (const [, src] of markup.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      expect(src, page).toMatch(
        /^(?:\/|https:\/\/res\.cloudinary\.com\/dlju18kt4\/image\/upload\/)/,
      );
    }
    for (const img of markup.match(/<img[^>]*>/g) ?? []) {
      expect(img, page).toMatch(/ alt="[^"]+"/);
    }
  }
});

test('build emits the changelog page, linked from the home page and llms.txt', () => {
  const page = readFileSync(`${dist}/changelog/index.html`, 'utf8');
  expect(page).toContain('<h1');
  expect(page).toContain('Changelog');
  expect(html()).toContain('href="/changelog/"');
  expect(readFileSync(`${dist}/llms.txt`, 'utf8')).toContain('/changelog/');
});

test('build emits the sitemap, the releases feed and a generated llms.txt', () => {
  expect(existsSync(`${dist}/sitemap-index.xml`)).toBe(true);
  const feed = readFileSync(`${dist}/releases.xml`, 'utf8');
  expect(feed).toContain('<rss');
  expect(feed).toContain('codecalc');
  const llms = readFileSync(`${dist}/llms.txt`, 'utf8');
  for (const name of ['codecalc', 'alexandria-mcp', 'audio-forge']) {
    expect(llms).toContain(`- [${name}](https://the40thieves.dev/${name}.md)`);
  }
  expect(llms).toContain('/manifest.json');
  expect(llms).toContain('https://the40thieves.dev/llms-full.txt');
  expect(llms).toContain('https://the40thieves.dev/AGENTS.md');
});

test('build emits a Markdown twin per page, the agent files and JSON-LD on every page (P3-S2)', () => {
  for (const file of [
    'index.md',
    '404.md',
    'changelog.md',
    'codecalc.md',
    'alexandria-mcp.md',
    'audio-forge.md',
    'llms-full.txt',
    'AGENTS.md',
  ]) {
    expect(existsSync(`${dist}/${file}`), file).toBe(true);
  }
  expect(readFileSync(`${dist}/codecalc.md`, 'utf8').startsWith('# codecalc\n')).toBe(true);
  for (const [page, type] of [
    ['index.html', 'WebSite'],
    ['changelog/index.html', 'Blog'],
    ['404.html', 'WebPage'],
    ['codecalc/index.html', 'SoftwareSourceCode'],
  ]) {
    const markup = readFileSync(`${dist}/${page}`, 'utf8');
    const ld = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(markup)?.[1];
    expect(ld, page).toBeDefined();
    expect((JSON.parse(ld ?? '{}') as { '@type'?: string })['@type'], page).toBe(type);
  }
  expect(html()).toMatch(/<link rel="alternate" type="text\/markdown" href="\/index\.md"\s*\/?>/);
  const headers = readFileSync(`${dist}/_headers`, 'utf8');
  expect(headers).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8');
  expect(headers).toContain('/:page/\n  Link: </:page.md>; rel="alternate"; type="text/markdown"');
});

test('pages print only live Origin Trial tokens and the WebMCP module is a lazy chunk (P3-S4)', () => {
  const committed = (
    JSON.parse(readFileSync('../../security/origin-trials.json', 'utf8')) as {
      tokens: { token: string }[];
    }
  ).tokens.map((entry) => entry.token);
  const live = activeTrialTokens(committed, Date.now());
  for (const file of ['index.html', 'codecalc/index.html', '404.html']) {
    const page = readFileSync(`${dist}/${file}`, 'utf8');
    const printed = [...page.matchAll(/<meta http-equiv="origin-trial" content="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(printed, file).toEqual(live);
  }
  // The registration module (the only code that names the annotations) is in exactly one chunk,
  // and no page loads that chunk eagerly: a browser without WebMCP never fetches it.
  const chunks = readdirSync(`${dist}/_astro`).filter((name) => name.endsWith('.js'));
  const lazy = chunks.filter((name) =>
    readFileSync(`${dist}/_astro/${name}`, 'utf8').includes('untrustedContentHint'),
  );
  expect(lazy).toHaveLength(1);
  const [chunk = ''] = lazy;
  const page = html();
  expect(page).not.toContain('untrustedContentHint');
  expect(page).not.toMatch(new RegExp(`<script[^>]+src="[^"]*${chunk.replace(/\./g, '\\.')}"`));
  expect(page).not.toMatch(new RegExp(`<link[^>]+href="[^"]*${chunk.replace(/\./g, '\\.')}"`));
});

test('build ships the org banner and one card per listed project, all self-contained SVG', () => {
  // P2-10: the org README embeds these through Camo, so nothing in them may reach out.
  expect(existsSync(`${dist}/og/banner.svg`)).toBe(true);
  for (const name of ['codecalc', 'alexandria-mcp', 'audio-forge']) {
    expect(existsSync(`${dist}/og/card/${name}.svg`), name).toBe(true);
  }
  const svgs = readdirSync(`${dist}/og/card`).map((f) => `${dist}/og/card/${f}`);
  for (const file of [`${dist}/og/banner.svg`, ...svgs]) {
    const svg = readFileSync(file, 'utf8');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svgViolations(svg), file).toEqual([]);
  }
  // Camo and the browser must revalidate: the headers file scopes no-cache to /og/*.
  expect(readFileSync(`${dist}/_headers`, 'utf8')).toContain('/og/*\n  Cache-Control: no-cache');
});

test('a project with a docs site links to it and the manifest carries the url (P2-07)', () => {
  const page = readFileSync(`${dist}/alexandria-mcp/index.html`, 'utf8');
  expect(page).toContain('href="/alexandria-mcp/docs/"');
  expect(page).toContain('https://github.com/The-40-Thieves/alexandria-mcp/tree/main/docs');
  const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, 'utf8')) as {
    projects: { slug: string; docs: string | null }[];
  };
  const docsOf = (slug: string) => manifest.projects.find((p) => p.slug === slug)?.docs;
  for (const slug of ['alexandria-mcp', 'audio-forge']) {
    expect(docsOf(slug), slug).toBe(`https://the40thieves.dev/${slug}/docs/`);
    expect(readFileSync(`${dist}/${slug}/index.html`, 'utf8')).toContain(`href="/${slug}/docs/"`);
  }
});

test('a project with docs published elsewhere links there, not to a hub docs path', () => {
  const docs = 'https://docs.the40thieves.dev/codecalc';
  const page = readFileSync(`${dist}/codecalc/index.html`, 'utf8');
  expect(page).toContain(`href="${docs}"`);
  expect(page).not.toContain('href="/codecalc/docs/"');
  expect(page).toContain('https://github.com/The-40-Thieves/codecalc/tree/main/docs');
  const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, 'utf8')) as {
    projects: { slug: string; docs: string | null }[];
  };
  expect(manifest.projects.find((p) => p.slug === 'codecalc')?.docs).toBe(docs);
});
