import type { ProjectEntry } from '@the40thieves/schemas';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

import { cardSvg } from '../../../lib/og-cards.ts';

/** One org README card per listed project (P2-10), prerendered to dist/og/card/<slug>.svg. */
export async function getStaticPaths() {
  const entries = await getCollection('projects');
  return entries
    .filter((entry) => entry.data.listed && entry.data.hub)
    .map((entry) => ({ params: { slug: entry.data.slug }, props: { project: entry.data } }));
}

export const GET: APIRoute<{ project: ProjectEntry }> = ({ props }) => {
  const { project } = props;
  const hub = project.hub;
  if (!hub) throw new Error(`${project.name} has no hub data`);
  const svg = cardSvg({
    name: project.name,
    slug: project.slug,
    tagline: hub.tagline,
    claim: { text: hub.claim.text, measured_on: hub.claim.measured_on },
    release: project.release
      ? { tag: project.release.tag, published_at: project.release.published_at }
      : null,
  });
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } });
};
