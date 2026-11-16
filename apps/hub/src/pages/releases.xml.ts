import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

import { renderReleaseNotes } from '../lib/markdown.ts';

/** One item per latest release across the organisation's public repositories. */
export async function GET(): Promise<Response> {
  const entries = (await getCollection('projects')).map((entry) => entry.data);
  const build = __BUILD_INFO__;
  const items = entries
    .flatMap((entry) => (entry.release ? [{ entry, release: entry.release }] : []))
    .sort((a, b) => b.release.published_at.localeCompare(a.release.published_at))
    .map(({ entry, release }) => ({
      title: `${entry.name} ${release.tag}`,
      link: release.url,
      pubDate: new Date(release.published_at),
      description: entry.hub?.tagline ?? entry.description ?? entry.name,
      content: renderReleaseNotes(release.body),
    }));
  return rss({
    title: 'The 40 Thieves releases',
    description: 'Latest releases of The 40 Thieves open-source tools.',
    site: build.site,
    items,
    customData: '<language>en</language>',
  });
}
