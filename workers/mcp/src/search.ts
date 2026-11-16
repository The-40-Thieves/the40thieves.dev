import type { LoadedDocsIndex } from '@the40thieves/manifest';
import type { Manifest } from '@the40thieves/schemas';

/** Lower-cased alphanumeric tokens of a query, de-duplicated, in query order. */
export function tokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0),
    ),
  ];
}

export interface ProjectHit {
  slug: string;
  name: string;
  tagline: string;
  page: string;
  repo: string;
  score: number;
}

/** Listed projects scored by token hits: name counts 3, tagline 2, description 1. */
export function searchProjects(manifest: Manifest, query: string): ProjectHit[] {
  const terms = tokens(query);
  const hits: ProjectHit[] = [];
  for (const project of manifest.projects) {
    if (!project.listed || project.page === null) continue;
    const name = project.name.toLowerCase();
    const tagline = project.tagline.toLowerCase();
    const description = (project.description ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      if (tagline.includes(term)) score += 2;
      if (description.includes(term)) score += 1;
    }
    if (score > 0) {
      hits.push({
        slug: project.slug,
        name: project.name,
        tagline: project.tagline,
        page: project.page,
        repo: project.repo,
        score,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

export interface DocHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

const SNIPPET_WIDTH = 200;

/** A window of `text` around the earliest occurrence of any term, whitespace collapsed. */
export function snippet(text: string, terms: readonly string[], width = SNIPPET_WIDTH): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 4));
  const end = Math.min(text.length, start + width);
  const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`;
}

/** MiniSearch over the twins, each hit with a snippet from the document text. */
export function searchDocs(docs: LoadedDocsIndex, query: string, limit: number): DocHit[] {
  const results = docs.search.search(query);
  const hits: DocHit[] = [];
  for (const result of results.slice(0, limit)) {
    const path = String(result['path']);
    const document = docs.documents.get(path);
    if (!document) continue;
    hits.push({
      path,
      title: document.title,
      snippet: snippet(document.text, result.terms.length > 0 ? result.terms : tokens(query)),
      score: Math.round(result.score * 1000) / 1000,
    });
  }
  return hits;
}
