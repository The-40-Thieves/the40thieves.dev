import type { ProjectEntry } from '@the40thieves/schemas';
import { getCollection } from 'astro:content';

import { markdownResponse, projectTwin } from '../lib/twins.ts';

import type { APIContext } from 'astro';

/** `/<project>.md`: the Markdown twin of each product page (P3-S2). */
export async function getStaticPaths() {
  const entries = await getCollection('projects');
  return entries
    .filter((entry) => entry.data.listed && entry.data.hub)
    .map((entry) => ({ params: { slug: entry.data.slug }, props: { project: entry.data } }));
}

export function GET({ props }: APIContext<{ project: ProjectEntry }>): Response {
  return markdownResponse(projectTwin(props.project, __BUILD_INFO__));
}
