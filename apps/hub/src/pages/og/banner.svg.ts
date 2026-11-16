import { getCollection } from 'astro:content';

import { bannerSvg } from '../../lib/og-cards.ts';

/** The org README banner (P2-10), prerendered to dist/og/banner.svg. */
export async function GET(): Promise<Response> {
  const entries = (await getCollection('projects')).map((entry) => entry.data);
  const projects = entries.filter((entry) => entry.listed).map((entry) => entry.name);
  return new Response(bannerSvg({ projects }), {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
  });
}
