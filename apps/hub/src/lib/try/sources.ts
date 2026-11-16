import {
  clip,
  idText,
  integer,
  list,
  plain,
  record,
  text,
  xmlBlocks,
  xmlText,
  type Json,
} from './text.ts';

/**
 * The try app's sources (P4-S4): eight of the routing matrix's entries, chosen so a search
 * exercises every route a browser can take. Each adapter builds the upstream request and reads
 * its answer into one shape; how the request leaves the browser (direct, or through the relay)
 * is `route`, and `tests/try-sources.test.ts` holds route and host to `data/sources.json`.
 */

/** The routes the app calls; `mcp-only` sources never leave the MCP server. */
export type TryRoute = 'browser-direct' | 'visitor-key-relay' | 'quota-relay';

export interface TryResult {
  /** The source's name in the routing matrix. */
  source: string;
  /** Stable within the source, for keys and de-duplication. */
  id: string;
  title: string;
  /** Where a reader can open the work, or null when the source gave none. */
  url: string | null;
  authors: string[];
  year: number | null;
  /** Abstract, standfirst or snippet, as plain text. */
  snippet: string;
}

/** The upstream call one search makes on one source, before routing. */
export interface UpstreamRequest {
  url: string;
  /** Extra headers, the visitor's key among them for a keyed source. */
  headers: Record<string, string>;
}

/** A source that needs the visitor's own key, and where that key goes. */
export interface VisitorKey {
  /** Id of the key in the key store. */
  id: string;
  label: string;
  /** Where the visitor gets one. */
  signup: string;
  header: string;
  prefix: string;
}

export interface TrySource {
  name: string;
  label: string;
  route: TryRoute;
  /** The single upstream host, lower case. */
  host: string;
  /** Present when the visitor must bring a key; the search skips the source without one. */
  key?: VisitorKey;
  request(query: string, limit: number, key?: string): UpstreamRequest;
  /** Read a response body. Throws on a body that is not the source's shape at all. */
  parse(body: string, limit: number): TryResult[];
}

/** Longest snippet kept per result; the answer step trims further. */
export const SNIPPET_CHARS = 1200;

function json(body: string): Json {
  const parsed: unknown = JSON.parse(body);
  const object = record(parsed);
  if (object === null) throw new Error('not a JSON object');
  return object;
}

function names(values: unknown[], read: (value: Json) => string): string[] {
  return values
    .map((value) => record(value))
    .filter((value): value is Json => value !== null)
    .map(read)
    .filter((name) => name !== '');
}

function doiUrl(doi: string): string | null {
  const bare = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return bare === '' ? null : `https://doi.org/${bare}`;
}

/** OpenAlex keeps abstracts as an inverted index: word to positions. */
export function invertedAbstract(index: unknown): string {
  const object = record(index);
  if (object === null) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(object)) {
    for (const at of list(positions)) {
      if (typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < 5000) words[at] = word;
    }
  }
  // filter() skips the holes positions left unset.
  return words.filter((word) => word !== '').join(' ');
}

function url(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

function finish(results: TryResult[], limit: number): TryResult[] {
  return results.filter((result) => result.title !== '').slice(0, limit);
}

const openalex: TrySource = {
  name: 'openalex',
  label: 'OpenAlex',
  route: 'browser-direct',
  host: 'api.openalex.org',
  request: (query, limit) => ({
    url: url('https://api.openalex.org/works', { search: query, 'per-page': String(limit) }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(json(body)['results']).flatMap((item): TryResult[] => {
        const work = record(item);
        if (work === null) return [];
        const doi = text(work['doi']);
        return [
          {
            source: 'openalex',
            id: text(work['id']),
            title: plain(text(work['display_name'])),
            url: (doi === '' ? null : doiUrl(doi)) ?? (text(work['id']) || null),
            authors: names(list(work['authorships']), (a) =>
              text(record(a['author'])?.['display_name']),
            ),
            year: integer(work['publication_year']),
            snippet: clip(invertedAbstract(work['abstract_inverted_index']), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

const crossref: TrySource = {
  name: 'crossref',
  label: 'Crossref',
  route: 'browser-direct',
  host: 'api.crossref.org',
  request: (query, limit) => ({
    url: url('https://api.crossref.org/works', {
      query,
      rows: String(limit),
      select: 'DOI,title,author,issued,abstract,URL',
    }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(record(json(body)['message'])?.['items']).flatMap((item): TryResult[] => {
        const work = record(item);
        if (work === null) return [];
        const doi = text(work['DOI']);
        const parts = list(record(work['issued'])?.['date-parts']);
        return [
          {
            source: 'crossref',
            id: doi,
            title: plain(text(list(work['title'])[0])),
            url: doiUrl(doi) ?? (text(work['URL']) || null),
            authors: names(list(work['author']), (a) =>
              [text(a['given']), text(a['family'])].filter(Boolean).join(' '),
            ),
            year: integer(list(parts[0])[0]),
            snippet: clip(plain(text(work['abstract'])), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

const europmc: TrySource = {
  name: 'europmc',
  label: 'Europe PMC',
  route: 'browser-direct',
  host: 'www.ebi.ac.uk',
  request: (query, limit) => ({
    url: url('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {
      query,
      format: 'json',
      pageSize: String(limit),
      resultType: 'core',
    }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(record(json(body)['resultList'])?.['result']).flatMap((item): TryResult[] => {
        const work = record(item);
        if (work === null) return [];
        const id = text(work['id']);
        const doi = text(work['doi']);
        const db = text(work['source']);
        return [
          {
            source: 'europmc',
            id: `${db}:${id}`,
            title: plain(text(work['title'])),
            url:
              doiUrl(doi) ??
              (id === '' || db === '' ? null : `https://europepmc.org/article/${db}/${id}`),
            authors: text(work['authorString']).replace(/\.$/, '').split(/,\s*/).filter(Boolean),
            year: integer(work['pubYear']),
            snippet: clip(plain(text(work['abstractText'])), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

/**
 * arXiv's `all:graph neural networks` matches any one of the words, so "graph neural networks"
 * came back as papers on any neural network. Every word is required instead; characters arXiv's
 * query syntax reads as operators separate words and are not sent.
 */
export function arxivQuery(query: string): string {
  // Split on anything that is not part of a word, so `graph/neural` stays two terms.
  const words = query
    .split(/[^\p{L}\p{N}\-.]+/u)
    .filter((word) => word !== '' && !/^(AND|OR|ANDNOT)$/.test(word));
  return words.length === 0 ? 'all:*' : words.map((word) => `all:${word}`).join(' AND ');
}

const arxiv: TrySource = {
  name: 'arxiv',
  label: 'arXiv',
  route: 'visitor-key-relay',
  host: 'export.arxiv.org',
  request: (query, limit) => ({
    url: url('https://export.arxiv.org/api/query', {
      search_query: arxivQuery(query),
      max_results: String(limit),
    }),
    headers: {},
  }),
  parse(body, limit) {
    if (!body.includes('<feed')) throw new Error('not an Atom feed');
    return finish(
      xmlBlocks(body, 'entry').map((entry) => {
        const id = xmlText(entry, 'id');
        return {
          source: 'arxiv',
          id,
          title: xmlText(entry, 'title'),
          url: id.startsWith('http') ? id.replace(/^http:/, 'https:') : null,
          authors: xmlBlocks(entry, 'author').map((author) => xmlText(author, 'name')),
          year: integer(xmlText(entry, 'published')),
          snippet: clip(xmlText(entry, 'summary'), SNIPPET_CHARS),
        };
      }),
      limit,
    );
  },
};

const semanticscholar: TrySource = {
  name: 'semanticscholar',
  label: 'Semantic Scholar',
  route: 'visitor-key-relay',
  host: 'api.semanticscholar.org',
  request: (query, limit) => ({
    url: url('https://api.semanticscholar.org/graph/v1/paper/search', {
      query,
      limit: String(limit),
      fields: 'title,abstract,year,authors,url,externalIds',
    }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(json(body)['data']).flatMap((item): TryResult[] => {
        const paper = record(item);
        if (paper === null) return [];
        return [
          {
            source: 'semanticscholar',
            id: text(paper['paperId']),
            title: plain(text(paper['title'])),
            url: text(paper['url']) || null,
            authors: names(list(paper['authors']), (a) => text(a['name'])),
            year: integer(paper['year']),
            snippet: clip(plain(text(paper['abstract'])), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

const core: TrySource = {
  name: 'core',
  label: 'CORE',
  route: 'visitor-key-relay',
  host: 'api.core.ac.uk',
  key: {
    id: 'core',
    label: 'CORE API key',
    signup: 'https://core.ac.uk/services/api',
    header: 'authorization',
    prefix: 'Bearer ',
  },
  request(query, limit, key) {
    const headers: Record<string, string> = {};
    if (key !== undefined) headers['authorization'] = `Bearer ${key}`;
    return {
      url: url('https://api.core.ac.uk/v3/search/works', { q: query, limit: String(limit) }),
      headers,
    };
  },
  parse(body, limit) {
    return finish(
      list(json(body)['results']).flatMap((item): TryResult[] => {
        const work = record(item);
        if (work === null) return [];
        const id = idText(work['id']);
        const doi = text(work['doi']);
        return [
          {
            source: 'core',
            id,
            title: plain(text(work['title'])),
            url: doiUrl(doi) ?? (id === '' ? null : `https://core.ac.uk/works/${id}`),
            authors: names(list(work['authors']), (a) => text(a['name'])),
            year: integer(work['yearPublished']),
            snippet: clip(plain(text(work['abstract'])), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

const guardian: TrySource = {
  name: 'guardian',
  label: 'The Guardian',
  route: 'quota-relay',
  host: 'content.guardianapis.com',
  // The relay adds the operator key; the page never holds one.
  request: (query, limit) => ({
    url: url('https://content.guardianapis.com/search', {
      q: query,
      'page-size': String(limit),
      'show-fields': 'trailText,byline',
    }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(record(json(body)['response'])?.['results']).flatMap((item): TryResult[] => {
        const article = record(item);
        if (article === null) return [];
        const fields = record(article['fields']);
        const byline = text(fields?.['byline']);
        return [
          {
            source: 'guardian',
            id: text(article['id']),
            title: plain(text(article['webTitle'])),
            url: text(article['webUrl']) || null,
            authors: byline === '' ? [] : byline.split(/,\s*|\s+and\s+/),
            year: integer(article['webPublicationDate']),
            snippet: clip(plain(text(fields?.['trailText'])), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

const courtlistener: TrySource = {
  name: 'courtlistener',
  label: 'CourtListener',
  route: 'quota-relay',
  host: 'www.courtlistener.com',
  request: (query) => ({
    url: url('https://www.courtlistener.com/api/rest/v4/search/', { q: query, type: 'o' }),
    headers: {},
  }),
  parse(body, limit) {
    return finish(
      list(json(body)['results']).flatMap((item): TryResult[] => {
        const opinion = record(item);
        if (opinion === null) return [];
        const path = text(opinion['absolute_url']);
        const court = text(opinion['court']);
        const snippet = text(record(list(opinion['opinions'])[0])?.['snippet']);
        return [
          {
            source: 'courtlistener',
            id: idText(opinion['cluster_id']) || path,
            title: plain(text(opinion['caseName'])),
            url: path.startsWith('/') ? `https://www.courtlistener.com${path}` : null,
            authors: court === '' ? [] : [court],
            year: integer(opinion['dateFiled']),
            snippet: clip(plain(snippet), SNIPPET_CHARS),
          },
        ];
      }),
      limit,
    );
  },
};

/** The curated eight, in the order the page lists them. */
export const TRY_SOURCES: readonly TrySource[] = [
  openalex,
  crossref,
  europmc,
  arxiv,
  semanticscholar,
  core,
  guardian,
  courtlistener,
];

export const ROUTE_LABELS: Readonly<Record<TryRoute, string>> = {
  'browser-direct': 'Your browser calls these directly.',
  'visitor-key-relay':
    'These do not allow this origin, so the relay forwards the call (and your key, when one is needed).',
  'quota-relay': 'The relay calls these with the site’s own key, under a small daily allowance.',
};
