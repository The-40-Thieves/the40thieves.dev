import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { manifestSchema } from '@the40thieves/schemas';
import {
  checkSurfaces,
  jsonLdBlocks,
  pageDeclaredTools,
  twinPath,
  webmcpToolsFor,
} from '@the40thieves/manifest';
import { expect, test } from 'vitest';

import { MAX_LLMS_FULL_BYTES } from '../src/lib/twins.ts';
import { expectedValue, loadPolicy, ruleApplies } from '../../../scripts/lib/policy.ts';

// Runs against the build output: every page, twin and
// llms.txt the build emitted must stay inside manifest.json.
const dist = 'dist/client';

function* walk(dir: string, ext: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, ext);
    else if (entry.isFile() && entry.name.endsWith(ext)) yield path;
  }
}

/** `dist/client/codecalc/index.html` is `/codecalc/`; `404.html` is `/404/`. */
function sitePath(file: string): string {
  const rel = relative(dist, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel.replace(/\.html$/, '')}/`;
}

/** `dist/client/codecalc.md` is `/codecalc.md`. */
function filePath(file: string): string {
  return `/${relative(dist, file).split(sep).join('/')}`;
}

function readManifest() {
  return manifestSchema.parse(
    JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as unknown,
  );
}

function readPages(): Map<string, string> {
  const pages = new Map<string, string>();
  for (const file of walk(dist, '.html')) pages.set(sitePath(file), readFileSync(file, 'utf8'));
  return pages;
}

test('manifest.json validates and every emitted page and llms.txt stays inside it', () => {
  const manifest = readManifest();
  const pages = readPages();
  const llms = join(dist, 'llms.txt');
  const cards = [...walk(join(dist, 'og'), '.svg')].map(filePath);
  const violations = checkSurfaces(manifest, {
    pages,
    llmsTxt: existsSync(llms) ? readFileSync(llms, 'utf8') : null,
    cards,
  });
  expect(cards).toContain('/og/banner.svg');
  expect(violations).toEqual([]);
  expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
});

test('every page has a Markdown twin and JSON-LD, and the headers link each page to its twin (P3-S2)', () => {
  const manifest = readManifest();
  const pages = readPages();
  const twins = new Map<string, string>();
  for (const file of walk(dist, '.md')) {
    const path = filePath(file);
    if (path === '/AGENTS.md') continue;
    twins.set(path, readFileSync(file, 'utf8'));
  }
  const jsonLd = new Map([...pages].map(([path, html]) => [path, jsonLdBlocks(html)]));
  expect(checkSurfaces(manifest, { pages, llmsTxt: null, twins, jsonLd })).toEqual([]);
  expect([...twins.keys()].sort()).toEqual(manifest.pages.map(twinPath).sort());

  const policy = loadPolicy();
  for (const page of manifest.pages) {
    const twin = twinPath(page);
    const rule = policy.headers.find(
      (r) => r.name === 'Link' && r.classes.includes('static') && ruleApplies(r, page),
    );
    if (!rule) throw new Error(`no Link rule applies to ${page}`);
    expect(expectedValue(rule, page), page).toBe(
      `<${twin}>; rel="alternate"; type="text/markdown"`,
    );
    expect(pages.get(page), page).toMatch(
      new RegExp(`<link rel="alternate" type="text/markdown" href="${twin}"\\s*/?>`),
    );
  }
  // The generated _headers is what production serves; the policy rules must have reached it.
  const headers = readFileSync(join(dist, '_headers'), 'utf8');
  expect(headers).toContain('/:page/\n  Link: </:page.md>; rel="alternate"; type="text/markdown"');
  expect(headers).toContain('\n/\n  Link: </index.md>; rel="alternate"; type="text/markdown"');
  expect(headers).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8');
});

test('every page declares exactly the WebMCP tools its route offers, all in the manifest (P3-S4)', () => {
  // The names in a page's tools meta are what its script may
  // register, so the built HTML is the surface.
  const manifest = readManifest();
  const pages = readPages();
  const webmcp = new Map([...pages].map(([path, html]) => [path, pageDeclaredTools(html)]));
  expect(checkSurfaces(manifest, { pages, llmsTxt: null, webmcp })).toEqual([]);
  for (const [path, names] of webmcp) expect(names, path).toEqual([...webmcpToolsFor(path)]);
  expect(webmcp.get('/')).toEqual(['search_projects', 'get_install']);
  expect(webmcp.get('/codecalc/')).toEqual(['search_projects', 'get_install', 'read_doc']);
  expect(webmcp.get('/changelog/')).toEqual(['search_projects', 'get_install', 'read_doc']);
  expect(webmcp.get('/404/')).toEqual([]);
});

test('llms-full.txt carries every twin under 1 MB and AGENTS.md names every project twin (P3-S2)', () => {
  const manifest = readManifest();
  const full = join(dist, 'llms-full.txt');
  expect(statSync(full).size).toBeLessThan(MAX_LLMS_FULL_BYTES);
  const text = readFileSync(full, 'utf8');
  for (const page of manifest.pages) {
    const twin = twinPath(page);
    const firstLine = readFileSync(join(dist, twin.slice(1)), 'utf8').split('\n')[0] ?? '';
    expect(text, twin).toContain(`<!-- ${manifest.site}${twin} -->\n${firstLine}`);
  }
  const agents = readFileSync(join(dist, 'AGENTS.md'), 'utf8');
  expect(agents).toContain(`${manifest.site}/manifest.json`);
  expect(agents).toContain(`${manifest.site}/llms-full.txt`);
  for (const project of manifest.projects) {
    expect(agents, project.slug).toContain(project.repo);
    if (project.page) expect(agents).toContain(`${manifest.site}${twinPath(project.page)}`);
  }
  expect(agents).toContain(`commit ${manifest.commit ?? ''}`);
});
