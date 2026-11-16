import { buildManifest, twinPath } from '@the40thieves/manifest';
import type { Manifest } from '@the40thieves/schemas';
import { getCollection } from 'astro:content';

import { designLibrary } from './design-library.ts';
import { sourcesFile } from './sources.ts';
import {
  changelogTwin,
  designLibraryTwin,
  indexTwin,
  notFoundTwin,
  projectTwin,
  sourcesTwin,
  tryTwin,
  type Twin,
} from './twins.ts';

/**
 * Every Markdown twin the site serves, in manifest page order, rendered once from the
 * collections (the same data the HTML pages read). The twin routes and `/llms-full.txt`
 * all draw from here, so the two can never disagree.
 */
export async function collectTwins(): Promise<{ manifest: Manifest; twins: Twin[] }> {
  const build = __BUILD_INFO__;
  const entries = (await getCollection('projects')).map((entry) => entry.data);
  const posts = (await getCollection('changelog')).map((entry) => entry.data);
  const manifest = buildManifest(entries, build, posts);
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const listed = new Set(entries.filter((entry) => entry.listed).map((entry) => entry.slug));
  const spotlight =
    (await getCollection('spotlights'))
      .map((entry) => entry.data)
      .sort((a, b) => b.published_at.localeCompare(a.published_at))
      .at(0) ?? null;
  const twins = manifest.pages.map((page): Twin => {
    const path = twinPath(page);
    if (page === '/') return { path, markdown: indexTwin(entries, spotlight, build) };
    if (page === '/404/') return { path, markdown: notFoundTwin(build) };
    if (page === '/changelog/') return { path, markdown: changelogTwin(posts, listed, build) };
    if (page === '/alexandria/sources/') return { path, markdown: sourcesTwin(sourcesFile, build) };
    if (page === '/alexandria/try/') return { path, markdown: tryTwin(build) };
    if (page === '/design/library/')
      return { path, markdown: designLibraryTwin(designLibrary, build) };
    const slug = page.replace(/^\/|\/$/g, '');
    const project = bySlug.get(slug);
    if (!project) throw new Error(`manifest page ${page} has no project entry`);
    return { path, markdown: projectTwin(project, build) };
  });
  return { manifest, twins };
}

/** The twin at `path`, or a build error: a route must never serve a twin outside the manifest. */
export async function twinAt(path: string): Promise<string> {
  const { twins } = await collectTwins();
  const twin = twins.find((candidate) => candidate.path === path);
  if (!twin) throw new Error(`no twin at ${path}; is the page in manifest.pages?`);
  return twin.markdown;
}
