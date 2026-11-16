import type { Manifest } from '@the40thieves/schemas';

import { twinPath } from './build.ts';
import { WEBMCP_TOOL_NAMES, webmcpToolsFor } from './webmcp.ts';

/** One place a surface fell outside the manifest. */
export interface Violation {
  surface: string;
  where: string;
  detail: string;
}

/** Everything the built site exposes that must stay inside the manifest. */
export interface SurfaceInputs {
  /** Site path (trailing slash) to the HTML the build emitted for it. */
  pages: Map<string, string>;
  /** The emitted `llms.txt`, or null when the build has none. */
  llmsTxt: string | null;
  /** Site paths of the emitted `/og/*.svg` files (the org README cards), if any. */
  cards?: string[];
  /** Site path (`/codecalc.md`) to the Markdown twin the build emitted for it (P3-S2). */
  twins?: Map<string, string>;
  /** Site path to the parsed JSON-LD blocks of its HTML page; see `jsonLdBlocks`. */
  jsonLd?: Map<string, unknown[]>;
  /** The tool names the `/mcp` Worker advertises in `tools/list` (P3-S1). */
  mcpTools?: readonly string[];
  /** Site path to the tool names its HTML declares for WebMCP (P3-S4). */
  webmcp?: Map<string, readonly string[]>;
  /** The tool names the Worker's `/mcp/webmcp` answers (P3-S4). */
  webmcpServed?: readonly string[];
}

export interface Surface {
  name: string;
  check(manifest: Manifest, inputs: SurfaceInputs): Violation[];
}

const HREF = /<a\s[^>]*?href=["']([^"'#?]+)[^"']*["']/gi;

/** Root-relative links that look like project pages: `/codecalc/` and nothing deeper. */
export function projectLinks(html: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(HREF)) {
    const href = match[1] ?? '';
    if (/^\/[a-z0-9-]+\/?$/.test(href)) links.add(href.endsWith('/') ? href : `${href}/`);
  }
  return [...links].sort();
}

/** Project names cited as `- [name](url)` list items in `llms.txt`. */
export function llmsProjects(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^-\s+\[([^\]]+)\]\(/gm)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

const pagesSurface: Surface = {
  name: 'pages',
  check(manifest, inputs) {
    const allowed = new Set(manifest.pages);
    const violations: Violation[] = [];
    for (const [path, html] of inputs.pages) {
      if (!allowed.has(path)) {
        violations.push({ surface: 'pages', where: path, detail: 'page is not in manifest.pages' });
      }
      for (const link of projectLinks(html)) {
        if (!allowed.has(link)) {
          violations.push({
            surface: 'pages',
            where: path,
            detail: `links to ${link}, which is not in manifest.pages`,
          });
        }
      }
    }
    return violations;
  },
};

const llmsSurface: Surface = {
  name: 'llms.txt',
  check(manifest, inputs) {
    if (inputs.llmsTxt === null) return [];
    const known = new Set(manifest.projects.map((project) => project.name));
    return llmsProjects(inputs.llmsTxt)
      .filter((name) => !known.has(name))
      .map((name) => ({
        surface: 'llms.txt',
        where: '/llms.txt',
        detail: `names ${name}, which is not a manifest project`,
      }));
  },
};

const CARD = /^\/og\/card\/([a-z0-9-]+)\.svg$/;

/** The org README cards (P2-10): the banner, and one card per project with a page. */
const cardsSurface: Surface = {
  name: 'cards',
  check(manifest, inputs) {
    const projects = new Map(manifest.projects.map((project) => [project.slug, project]));
    const violations: Violation[] = [];
    for (const path of inputs.cards ?? []) {
      if (path === '/og/banner.svg') continue;
      const slug = CARD.exec(path)?.[1];
      if (slug === undefined) {
        violations.push({
          surface: 'cards',
          where: path,
          detail: 'not a banner or a project card path',
        });
        continue;
      }
      const project = projects.get(slug);
      if (!project) {
        violations.push({
          surface: 'cards',
          where: path,
          detail: `${slug} is not a manifest project`,
        });
      } else if (project.page === null) {
        violations.push({
          surface: 'cards',
          where: path,
          detail: `${slug} has no page in the manifest`,
        });
      }
    }
    return violations;
  },
};

const PAGE_SHAPE = /^\/(?:[a-z0-9-]+\/)*$/;
const PROJECT_SHAPE = /^\/[a-z0-9-]+\/?$/;
const TWIN_SHAPE = /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/;

/** Root-relative paths of every Markdown link target and every bare site URL in `markdown`. */
function markdownPaths(markdown: string, site: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (target.startsWith('/')) paths.push(target);
    else if (target.startsWith(`${site}/`)) paths.push(target.slice(site.length));
  }
  for (const match of markdown.matchAll(/https?:\/\/[^\s)<>]+/g)) {
    if (match[0].startsWith(`${site}/`)) paths.push(match[0].slice(site.length));
  }
  return paths.map((path) => path.replace(/[?#].*$/, ''));
}

/** Project-page-shaped links (`/codecalc/`) in a Markdown twin, root-relative or on the site. */
export function markdownPageLinks(markdown: string, site: string): string[] {
  const links = new Set<string>();
  for (const path of markdownPaths(markdown, site)) {
    if (PROJECT_SHAPE.test(path)) links.add(path.endsWith('/') ? path : `${path}/`);
  }
  return [...links].sort();
}

/** Twin-shaped links (`/codecalc.md`) in a Markdown twin, root-relative or on the site. */
export function markdownTwinLinks(markdown: string, site: string): string[] {
  const links = new Set<string>();
  for (const path of markdownPaths(markdown, site)) {
    if (TWIN_SHAPE.test(path)) links.add(path);
  }
  return [...links].sort();
}

const LD_SCRIPT = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every `application/ld+json` block in `html`, parsed. A block that is not JSON is a build bug. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(LD_SCRIPT)) {
    const text = match[1] ?? '';
    try {
      blocks.push(JSON.parse(text) as unknown);
    } catch (error) {
      throw new Error(`malformed JSON-LD block: ${text.slice(0, 80)}`, { cause: error });
    }
  }
  return blocks;
}

/** The Markdown twins (P3-S2): one per manifest page, none for anything else. */
const twinsSurface: Surface = {
  name: 'twins',
  check(manifest, inputs) {
    if (!inputs.twins) return [];
    const violations: Violation[] = [];
    const expected = new Map(manifest.pages.map((page) => [twinPath(page), page]));
    for (const [twin, page] of expected) {
      if (!inputs.twins.has(twin)) {
        violations.push({ surface: 'twins', where: page, detail: `page has no twin at ${twin}` });
      }
    }
    const allowed = new Set(manifest.pages);
    for (const [path, markdown] of inputs.twins) {
      if (!expected.has(path)) {
        violations.push({
          surface: 'twins',
          where: path,
          detail: 'twin is not for a manifest page',
        });
        continue;
      }
      for (const link of markdownPageLinks(markdown, manifest.site)) {
        if (!allowed.has(link)) {
          violations.push({
            surface: 'twins',
            where: path,
            detail: `links to ${link}, which is not in manifest.pages`,
          });
        }
      }
      for (const link of markdownTwinLinks(markdown, manifest.site)) {
        if (!expected.has(link)) {
          violations.push({
            surface: 'twins',
            where: path,
            detail: `links to ${link}, which is not a manifest twin`,
          });
        }
      }
    }
    return violations;
  },
};

function* nodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
  } else if (typeof value === 'object' && value !== null) {
    const node = value as Record<string, unknown>;
    yield node;
    for (const child of Object.values(node)) yield* nodes(child);
  }
}

/** The page path a site URL names, or null when it is not page-shaped (a feed, a twin). */
function sitePagePath(url: string, site: string): string | null {
  if (!url.startsWith(`${site}/`)) return null;
  const path = new URL(url).pathname;
  return PAGE_SHAPE.test(path) ? path : null;
}

/** JSON-LD (P3-S2): every page carries some, and it names only manifest projects and pages. */
const jsonLdSurface: Surface = {
  name: 'json-ld',
  check(manifest, inputs) {
    if (!inputs.jsonLd) return [];
    const violations: Violation[] = [];
    const pages = new Set(manifest.pages);
    const projects = new Map(manifest.projects.map((project) => [project.name, project]));
    for (const [path, blocks] of inputs.jsonLd) {
      if (blocks.length === 0) {
        violations.push({ surface: 'json-ld', where: path, detail: 'page carries no JSON-LD' });
        continue;
      }
      for (const node of nodes(blocks)) {
        const name = node['name'];
        if (node['@type'] === 'SoftwareSourceCode' && typeof name === 'string') {
          const project = projects.get(name);
          if (!project) {
            violations.push({
              surface: 'json-ld',
              where: path,
              detail: `names ${name}, which is not a manifest project`,
            });
          } else if (project.page === null) {
            violations.push({
              surface: 'json-ld',
              where: path,
              detail: `names ${name}, which has no page in the manifest`,
            });
          }
        }
        const url = node['url'];
        const page = typeof url === 'string' ? sitePagePath(url, manifest.site) : null;
        if (page !== null && !pages.has(page)) {
          violations.push({
            surface: 'json-ld',
            where: path,
            detail: `links to ${page}, which is not in manifest.pages`,
          });
        }
      }
    }
    return violations;
  },
};

/** The `/mcp` Worker (P3-S1): it serves the manifest's tool list, whole and nothing else. */
const mcpSurface: Surface = {
  name: 'mcp',
  check(manifest, inputs) {
    if (!inputs.mcpTools) return [];
    const allowed = new Set(manifest.mcp.tools.map((tool) => tool.name));
    const served = new Set(inputs.mcpTools);
    const violations: Violation[] = [];
    for (const name of served) {
      if (!allowed.has(name)) {
        violations.push({
          surface: 'mcp',
          where: name,
          detail: 'served tool is not in manifest.mcp.tools',
        });
      }
    }
    for (const name of allowed) {
      if (!served.has(name)) {
        violations.push({ surface: 'mcp', where: name, detail: 'manifest tool is not served' });
      }
    }
    return violations;
  },
};

/**
 * WebMCP page tools (P3-S4): a page declares only tools the manifest lists and its route
 * offers, and the Worker's page endpoint answers only tools from that same subset.
 */
const webmcpSurface: Surface = {
  name: 'webmcp',
  check(manifest, inputs) {
    const allowed = new Set(manifest.mcp.tools.map((tool) => tool.name));
    const violations: Violation[] = [];
    for (const [page, names] of inputs.webmcp ?? []) {
      const offered = new Set(webmcpToolsFor(page));
      for (const name of names) {
        if (!allowed.has(name)) {
          violations.push({
            surface: 'webmcp',
            where: page,
            detail: `declares ${name}, which is not in manifest.mcp.tools`,
          });
        } else if (!offered.has(name)) {
          violations.push({
            surface: 'webmcp',
            where: page,
            detail: `declares ${name}, which the route map does not offer on this page`,
          });
        }
      }
    }
    const subset = new Set(WEBMCP_TOOL_NAMES);
    for (const name of inputs.webmcpServed ?? []) {
      if (!allowed.has(name)) {
        violations.push({
          surface: 'webmcp',
          where: name,
          detail: 'served page tool is not in manifest.mcp.tools',
        });
      }
      if (!subset.has(name)) {
        violations.push({
          surface: 'webmcp',
          where: name,
          detail: 'served page tool is not a WebMCP page tool',
        });
      }
    }
    return violations;
  },
};

/** Later phases append the org README itself here. */
export const surfaces: Surface[] = [
  pagesSurface,
  llmsSurface,
  cardsSurface,
  twinsSurface,
  jsonLdSurface,
  mcpSurface,
  webmcpSurface,
];

export function checkSurfaces(manifest: Manifest, inputs: SurfaceInputs): Violation[] {
  return surfaces.flatMap((surface) => surface.check(manifest, inputs));
}
