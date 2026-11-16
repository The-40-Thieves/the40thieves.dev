import { expect, test } from 'vitest';

import sources from '../../../data/sources.json' with { type: 'json' };
import {
  arxivQuery,
  invertedAbstract,
  TRY_SOURCES,
  type TrySource,
} from '../src/lib/try/sources.ts';
import { clip, decodeEntities, plain } from '../src/lib/try/text.ts';

// The try app's adapters (P4-S4): each builds the upstream URL and reads a trimmed copy of
// the source's real response shape. Fixtures are hand-cut from the APIs' documented shapes.

function source(name: string): TrySource {
  const found = TRY_SOURCES.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(name);
  return found;
}

test('every source matches its routing-matrix entry: route, single host, key', () => {
  expect(TRY_SOURCES.map((s) => s.name)).toEqual([
    'openalex',
    'crossref',
    'europmc',
    'arxiv',
    'semanticscholar',
    'core',
    'guardian',
    'courtlistener',
  ]);
  for (const adapter of TRY_SOURCES) {
    const entry = sources.sources.find((s) => s.name === adapter.name);
    expect(entry, adapter.name).toBeDefined();
    expect(adapter.route, adapter.name).toBe(entry?.route);
    expect([adapter.host], adapter.name).toEqual(entry?.hosts);
    // A visitor key only where the matrix says the visitor brings one.
    const visitorKeyed = entry?.route === 'visitor-key-relay' && entry.key !== null;
    expect(adapter.key !== undefined, adapter.name).toBe(visitorKeyed);
  }
});

test('every request goes to the adapter host, over https, carrying the query and limit', () => {
  for (const adapter of TRY_SOURCES) {
    const { url } = adapter.request('graph neural networks', 7, 'k');
    const parsed = new URL(url);
    expect(parsed.protocol, adapter.name).toBe('https:');
    expect(parsed.hostname, adapter.name).toBe(adapter.host);
    const search = decodeURIComponent(parsed.search).replace(/\+/g, ' ');
    // arXiv sends each word as its own required term (see arxivQuery); the rest send the phrase.
    for (const word of ['graph', 'neural', 'networks']) {
      expect(search, adapter.name).toContain(word);
    }
    if (adapter.name !== 'arxiv') expect(search, adapter.name).toContain('graph neural networks');
  }
});

test('arxiv requires every word, and drops query operators', () => {
  expect(arxivQuery('graph neural networks')).toBe('all:graph AND all:neural AND all:networks');
  expect(arxivQuery('  "attention" (is) OR all ')).toBe('all:attention AND all:is AND all:all');
  expect(arxivQuery('()')).toBe('all:*');
  // Punctuation separates words instead of gluing them together.
  expect(arxivQuery('graph/neural')).toBe('all:graph AND all:neural');
  expect(arxivQuery('GNN:attention')).toBe('all:GNN AND all:attention');
  const { url } = source('arxiv').request('graph neural networks', 5);
  expect(new URL(url).searchParams.get('search_query')).toBe(
    'all:graph AND all:neural AND all:networks',
  );
});

test('quota sources never carry a key from the page', () => {
  for (const name of ['guardian', 'courtlistener']) {
    const { url, headers } = source(name).request('q', 5, 'visitor-key');
    expect(url).not.toContain('api-key');
    expect(headers).toEqual({});
  }
});

test('CORE sends the visitor key as a bearer token, and nothing without one', () => {
  expect(source('core').request('q', 5, 'abc').headers).toEqual({ authorization: 'Bearer abc' });
  expect(source('core').request('q', 5).headers).toEqual({});
});

test('openalex: title, DOI link, authors, year and the rebuilt abstract', () => {
  const body = JSON.stringify({
    results: [
      {
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1/abc',
        display_name: 'Graph <i>networks</i>',
        publication_year: 2021,
        authorships: [{ author: { display_name: 'Ada Lovelace' } }, { author: {} }],
        abstract_inverted_index: { networks: [1], Graph: [0], learn: [2] },
      },
      { id: 'https://openalex.org/W2', display_name: '' },
      'junk',
    ],
  });
  expect(source('openalex').parse(body, 10)).toEqual([
    {
      source: 'openalex',
      id: 'https://openalex.org/W1',
      title: 'Graph networks',
      url: 'https://doi.org/10.1/abc',
      authors: ['Ada Lovelace'],
      year: 2021,
      snippet: 'Graph networks learn',
    },
  ]);
});

test('crossref: JATS abstract to text, given and family names, issued year', () => {
  const body = JSON.stringify({
    message: {
      items: [
        {
          DOI: '10.2/xyz',
          title: ['A title'],
          author: [{ given: 'Grace', family: 'Hopper' }, { family: 'Turing' }],
          issued: { 'date-parts': [[2019, 4]] },
          abstract: '<jats:p>Short &amp; sweet.</jats:p>',
        },
      ],
    },
  });
  expect(source('crossref').parse(body, 10)[0]).toMatchObject({
    url: 'https://doi.org/10.2/xyz',
    authors: ['Grace Hopper', 'Turing'],
    year: 2019,
    snippet: 'Short & sweet.',
  });
});

test('europmc: authorString split, falls back to the Europe PMC page without a DOI', () => {
  const body = JSON.stringify({
    resultList: {
      result: [
        {
          id: '123',
          source: 'MED',
          title: 'Trial.',
          authorString: 'Smith J, Doe A.',
          pubYear: '2020',
          abstractText: 'Results <b>here</b>.',
        },
      ],
    },
  });
  expect(source('europmc').parse(body, 10)[0]).toMatchObject({
    id: 'MED:123',
    url: 'https://europepmc.org/article/MED/123',
    authors: ['Smith J', 'Doe A'],
    year: 2020,
    snippet: 'Results here .',
  });
});

test('arxiv: Atom entries, https abs link, authors, published year', () => {
  const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>http://arxiv.org/abs/2101.00001v1</id><published>2021-01-01T00:00:00Z</published>
    <title>Attention &amp; more</title><summary>  We study
    things. </summary><author><name>A. One</name></author><author><name>B. Two</name></author></entry>
  </feed>`;
  expect(source('arxiv').parse(body, 10)).toEqual([
    {
      source: 'arxiv',
      id: 'http://arxiv.org/abs/2101.00001v1',
      title: 'Attention & more',
      url: 'https://arxiv.org/abs/2101.00001v1',
      authors: ['A. One', 'B. Two'],
      year: 2021,
      snippet: 'We study things.',
    },
  ]);
  expect(() => source('arxiv').parse('{"ok":true}', 10)).toThrow(/Atom/);
});

test('semanticscholar, core, guardian and courtlistener read their shapes', () => {
  expect(
    source('semanticscholar').parse(
      JSON.stringify({
        data: [
          {
            paperId: 'p1',
            title: 'S2',
            url: 'https://www.semanticscholar.org/paper/p1',
            year: 2022,
            authors: [{ name: 'X' }],
            abstract: null,
          },
        ],
      }),
      10,
    )[0],
  ).toMatchObject({ url: 'https://www.semanticscholar.org/paper/p1', snippet: '', year: 2022 });
  expect(
    source('core').parse(
      JSON.stringify({
        results: [{ id: 42, title: 'C', yearPublished: 2018, authors: [{ name: 'Y' }] }],
      }),
      10,
    )[0],
  ).toMatchObject({ id: '42', url: 'https://core.ac.uk/works/42' });
  expect(
    source('guardian').parse(
      JSON.stringify({
        response: {
          results: [
            {
              id: 'world/1',
              webTitle: 'News',
              webUrl: 'https://www.theguardian.com/world/1',
              webPublicationDate: '2026-01-02T00:00:00Z',
              fields: { trailText: '<p>Lead</p>', byline: 'A and B' },
            },
          ],
        },
      }),
      10,
    )[0],
  ).toMatchObject({ authors: ['A', 'B'], year: 2026, snippet: 'Lead' });
  expect(
    source('courtlistener').parse(
      JSON.stringify({
        results: [
          {
            cluster_id: 9,
            caseName: 'Roe v. Doe',
            absolute_url: '/opinion/9/roe-v-doe/',
            court: 'Supreme Court',
            dateFiled: '1999-05-01',
            opinions: [{ snippet: 'held <mark>that</mark>' }],
          },
        ],
      }),
      10,
    )[0],
  ).toMatchObject({
    id: '9',
    url: 'https://www.courtlistener.com/opinion/9/roe-v-doe/',
    authors: ['Supreme Court'],
    year: 1999,
    snippet: 'held that',
  });
});

test('parsers honour the limit and reject a body that is not their shape', () => {
  const many = JSON.stringify({
    data: Array.from({ length: 30 }, (_, i) => ({ paperId: String(i), title: `T${String(i)}` })),
  });
  expect(source('semanticscholar').parse(many, 5)).toHaveLength(5);
  expect(() => source('openalex').parse('[]', 5)).toThrow();
  expect(() => source('crossref').parse('not json', 5)).toThrow();
});

test('text helpers: entities, tags, clipping, inverted abstracts', () => {
  expect(decodeEntities('&lt;a&gt; &#39;b&#39; &#x41; &unknown;')).toBe("<a> 'b' A &unknown;");
  expect(plain('<p>one</p>\n<p>two</p>')).toBe('one two');
  expect(clip('alpha beta gamma delta', 12)).toBe('alpha beta…');
  expect(invertedAbstract({ b: [1], a: [0], bad: [-1, 'x', 99999] })).toBe('a b');
  expect(invertedAbstract(null)).toBe('');
});
