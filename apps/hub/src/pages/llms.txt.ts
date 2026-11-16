import { getCollection } from 'astro:content';

function line(name: string, url: string, summary: string | null | undefined): string {
  return summary ? `- [${name}](${url}): ${summary}` : `- [${name}](${url})`;
}

/**
 * Short index for agents, linking each project's Markdown twin (P3-S2); the contract
 * test keeps every name inside manifest.json, and `/llms-full.txt` carries the twins whole.
 */
export async function GET(): Promise<Response> {
  const entries = (await getCollection('projects')).map((entry) => entry.data);
  const site = __BUILD_INFO__.site;
  const listed = entries.filter((entry) => entry.listed);
  const unlisted = entries.filter((entry) => !entry.listed);
  const lines = [
    '# The 40 Thieves',
    '',
    '> Open-source developer tools, each with one measured claim and a one-line install.',
    '',
    `Machine-readable index of everything on this site: ${site}/manifest.json`,
    `Everything in one file: ${site}/llms-full.txt`,
    `How agents should read this site: ${site}/AGENTS.md`,
    '',
    '## Projects',
    '',
    ...listed.map((entry) => line(entry.name, `${site}/${entry.slug}.md`, entry.hub?.tagline)),
    '',
    '## Also on GitHub',
    '',
    ...unlisted.map((entry) => line(entry.name, entry.url, entry.description)),
    '',
    `Releases feed: ${site}/releases.xml`,
    `Changelog: ${site}/changelog.md (HTML: ${site}/changelog/)`,
    `alexandria source routing matrix: ${site}/alexandria/sources.md (HTML: ${site}/alexandria/sources/, JSON: ${site}/alexandria/sources.json)`,
    `Try alexandria (search with your own keys, cited answers): ${site}/alexandria/try.md (HTML: ${site}/alexandria/try/)`,
    `Design resource library, licence-checked: ${site}/design/library.md (HTML: ${site}/design/library/, JSON: ${site}/design/library.json)`,
    '',
  ];
  return new Response(lines.join('\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
