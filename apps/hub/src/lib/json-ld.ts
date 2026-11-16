import type { BuildInfo } from '@the40thieves/manifest';
import type {
  ChangelogPost,
  DesignLibrary,
  ProjectEntry,
  SourcesFile,
} from '@the40thieves/schemas';

/**
 * JSON-LD (schema.org) for every page (P3-S2). Pure functions of the collection data, so
 * the unit tests render them from the fixtures; the contract test keeps every URL and project
 * name they emit inside the manifest.
 */

const CONTEXT = 'https://schema.org';

function organization(build: BuildInfo) {
  return { '@type': 'Organization', name: 'The 40 Thieves', url: build.site };
}

/** `SoftwareSourceCode` for a product page. */
export function projectLd(project: ProjectEntry, build: BuildInfo): Record<string, unknown> {
  const hub = project.hub;
  if (!hub) throw new Error(`${project.name} has no hub data`);
  return {
    '@context': CONTEXT,
    '@type': 'SoftwareSourceCode',
    name: project.name,
    description: hub.tagline,
    url: `${build.site}/${project.slug}/`,
    codeRepository: project.url,
    license: project.license ? `https://spdx.org/licenses/${project.license}` : undefined,
    version: project.release?.tag,
    dateModified: project.head.committed_at,
    maintainer: organization(build),
  };
}

/** `WebSite` for the home page, listing the projects that have a page. */
export function siteLd(entries: ProjectEntry[], build: BuildInfo): Record<string, unknown> {
  const listed = [...entries]
    .filter((entry) => entry.listed && entry.hub)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    name: 'The 40 Thieves',
    description:
      'Open-source developer tools, each with one measured claim and a one-line install.',
    url: `${build.site}/`,
    publisher: organization(build),
    hasPart: listed.map((entry) => ({
      '@type': 'SoftwareSourceCode',
      name: entry.name,
      url: `${build.site}/${entry.slug}/`,
      codeRepository: entry.url,
    })),
  };
}

/** `Blog` for the changelog, one `BlogPosting` per post in the order given. */
export function changelogLd(posts: ChangelogPost[], build: BuildInfo): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@type': 'Blog',
    name: 'Changelog',
    url: `${build.site}/changelog/`,
    publisher: organization(build),
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.title,
      datePublished: post.published_at,
      dateModified: post.updated_at,
      url: `${build.site}/changelog/#${post.slug}`,
    })),
  };
}

/** `WebPage` for the not-found page. */
export function notFoundLd(build: BuildInfo): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@type': 'WebPage',
    name: 'Not found',
    url: `${build.site}/404/`,
    isPartOf: { '@type': 'WebSite', url: `${build.site}/` },
  };
}

/** `Dataset` for the alexandria source routing matrix (P4-S1), distributed as JSON. */
export function sourcesLd(file: SourcesFile, build: BuildInfo): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@type': 'Dataset',
    name: 'alexandria source routing matrix',
    description: `${String(file.sources.length)} alexandria-mcp sources classified by CORS, key requirement and terms into one route each: browser-direct, visitor-key-relay, quota-relay or mcp-only.`,
    url: `${build.site}/alexandria/sources/`,
    creator: organization(build),
    isBasedOn: `https://github.com/${file.upstream.repo}`,
    distribution: {
      '@type': 'DataDownload',
      contentUrl: `${build.site}/alexandria/sources.json`,
      encodingFormat: 'application/json',
    },
    isPartOf: { '@type': 'WebSite', url: `${build.site}/` },
  };
}

/** `WebApplication` for the alexandria try app (P4-S4): free, runs in the browser. */
export function tryLd(build: BuildInfo): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@type': 'WebApplication',
    name: 'Try alexandria',
    description:
      "Search eight of alexandria-mcp's sources from the browser with the visitor's own keys, read the abstracts, and get an answer from the visitor's own model that cites them.",
    url: `${build.site}/alexandria/try/`,
    applicationCategory: 'ResearchApplication',
    operatingSystem: 'Any (runs in a web browser)',
    browserRequirements: 'Requires JavaScript.',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    creator: organization(build),
    isPartOf: { '@type': 'WebSite', url: `${build.site}/` },
  };
}

/** `Dataset` for the design resource library, distributed as JSON. */
export function designLibraryLd(file: DesignLibrary, build: BuildInfo): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@type': 'Dataset',
    name: 'Design resource library',
    description: `${String(file.items.length)} design, motion and graphics resources, each marked clear, conditions or study for commercial use, with its licence and the terms page read.`,
    url: `${build.site}/design/library/`,
    creator: organization(build),
    dateModified: file.verified,
    distribution: {
      '@type': 'DataDownload',
      contentUrl: `${build.site}/design/library.json`,
      encodingFormat: 'application/json',
    },
    isPartOf: { '@type': 'WebSite', url: `${build.site}/` },
  };
}
