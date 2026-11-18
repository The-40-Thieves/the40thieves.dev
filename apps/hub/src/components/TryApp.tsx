import { useEffect, useMemo, useRef, useState } from 'react';

import {
  answerRequest,
  citeParts,
  pickForAnswer,
  PROVIDERS,
  providerOf,
  readAnswer,
  type Provider,
} from '../lib/try/answer.ts';
import { opfsFiles, ResultCache } from '../lib/try/cache.ts';
import { KeyStore } from '../lib/try/keys.ts';
import {
  failureText,
  mintSession,
  routeRequest,
  sessionIsFresh,
  sitekeyFor,
  TURNSTILE_SCRIPT,
  type RelaySession,
} from '../lib/try/relay.ts';
import {
  ROUTE_LABELS,
  TRY_SOURCES,
  type TryResult,
  type TryRoute,
  type TrySource,
} from '../lib/try/sources.ts';
import { webUrl } from '../lib/try/text.ts';
import { tierFor, type Tier } from '../lib/try/tier.ts';

/**
 * The alexandria try app (P4-S4), the site's first React island: the visitor's keys, a
 * search across the curated sources, each result's abstract, and an answer from the visitor's
 * own model that cites the results. Keys stay in this module's memory unless the visitor opts in
 * to keeping them for the tab; see `lib/try/keys.ts`.
 */

const LLM_KEY = 'llm';
const SEARCH_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 60_000;

type Status =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; count: number; cached: boolean }
  | { state: 'skipped'; reason: string }
  | { state: 'error'; reason: string };

interface Turnstile {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
  interface Navigator {
    deviceMemory?: number;
  }
}

/** Load Turnstile once, on the first search that needs the relay. */
let turnstileLoad: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  turnstileLoad ??= new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile !== undefined) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.turnstile === undefined) reject(new Error('Turnstile did not start'));
      else resolve(window.turnstile);
    });
    script.addEventListener('error', () => {
      turnstileLoad = null;
      reject(new Error('Turnstile did not load'));
    });
    document.head.appendChild(script);
  });
  return turnstileLoad;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const SOURCE_GROUPS: { route: TryRoute; sources: TrySource[] }[] = (
  ['browser-direct', 'visitor-key-relay', 'quota-relay'] as const
).map((route) => ({ route, sources: TRY_SOURCES.filter((source) => source.route === route) }));

function statusText(status: Status): string {
  switch (status.state) {
    case 'idle':
      return '';
    case 'loading':
      return 'Searching…';
    case 'ok':
      return `${String(status.count)} result${status.count === 1 ? '' : 's'}${status.cached ? ' (from this device)' : ''}`;
    case 'skipped':
    case 'error':
      return status.reason;
  }
}

export default function TryApp() {
  const store = useMemo(
    () => (typeof window === 'undefined' ? null : new KeyStore(sessionStore())),
    [],
  );
  const [tier, setTier] = useState<Tier>(tierFor(undefined));
  const [cache, setCache] = useState<ResultCache | null>(null);
  const [llmKey, setLlmKey] = useState('');
  const [coreKey, setCoreKey] = useState('');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(PROVIDERS.anthropic.model);
  const [persist, setPersist] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(TRY_SOURCES.map((source) => source.name)),
  );
  const [statuses, setStatuses] = useState<Partial<Record<string, Status>>>({});
  const [results, setResults] = useState<TryResult[]>([]);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; sources: TryResult[] } | null>(null);
  const [answerState, setAnswerState] = useState<'idle' | 'loading' | { error: string }>('idle');
  const session = useRef<RelaySession | null>(null);
  const widget = useRef<HTMLDivElement>(null);

  // Restore an opted-in tab copy, measure the tier, open the cache.
  useEffect(() => {
    if (store === null) return;
    setLlmKey(store.get(LLM_KEY));
    setCoreKey(store.get('core'));
    setPersist(store.persisted);
    const saved = providerOf(store.get(LLM_KEY));
    if (saved !== null) {
      setProvider(saved);
      setModel(PROVIDERS[saved].model);
    }
    const measured = tierFor(navigator.deviceMemory);
    setTier(measured);
    if (measured.cacheEntries > 0) {
      void opfsFiles().then((files) => {
        if (files !== null) setCache(new ResultCache(files, measured.cacheEntries));
      });
    }
  }, [store]);

  function updateKey(id: string, value: string): void {
    store?.set(id, value);
    if (id === LLM_KEY) {
      setLlmKey(value);
      const guessed = providerOf(value.trim());
      if (guessed !== null && guessed !== provider) {
        setProvider(guessed);
        setModel(PROVIDERS[guessed].model);
      }
    } else setCoreKey(value);
  }

  function forgetKeys(): void {
    store?.clear();
    setLlmKey('');
    setCoreKey('');
    setPersist(false);
  }

  async function relaySession(): Promise<string> {
    if (sessionIsFresh(session.current, Date.now())) return session.current?.session ?? '';
    const turnstile = await loadTurnstile();
    const element = widget.current;
    if (element === null) throw new Error('no place for the check');
    const token = await new Promise<string>((resolve, reject) => {
      const id = turnstile.render(element, {
        sitekey: sitekeyFor(location.hostname),
        callback: (value) => {
          resolve(value);
          setTimeout(() => {
            turnstile.remove(id);
          }, 0);
        },
        'error-callback': () => {
          reject(new Error('The check did not pass.'));
        },
        'expired-callback': () => {
          reject(new Error('The check expired.'));
        },
      });
    });
    session.current = await mintSession(token);
    return session.current.session;
  }

  async function searchOne(
    source: TrySource,
    q: string,
    relay: string | null,
  ): Promise<TryResult[]> {
    const key = source.key === undefined ? undefined : store?.get(source.key.id);
    const { url, init } = routeRequest(source, source.request(q, tier.perSource, key), relay);
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    const body = await response.text();
    if (!response.ok) {
      let code: string | null = null;
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (typeof parsed.error === 'string') code = parsed.error;
      } catch {
        // Not a relay error body.
      }
      throw new Error(failureText(response.status, response.headers.get('retry-after'), code));
    }
    return source.parse(body, tier.perSource);
  }

  async function search(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    const q = query.trim();
    if (q === '' || busy) return;
    setBusy(true);
    setAnswer(null);
    setAnswerState('idle');
    setSearched(q);
    const chosen = TRY_SOURCES.filter((source) => selected.has(source.name));
    const names = chosen.map((source) => source.name);

    const hit = await cache?.get(q, names, tier.perSource);
    if (hit !== undefined && hit !== null) {
      setResults(hit.results);
      setStatuses(
        Object.fromEntries(
          chosen.map((source) => [
            source.name,
            {
              state: 'ok',
              count: hit.results.filter((r) => r.source === source.name).length,
              cached: true,
            },
          ]),
        ),
      );
      setBusy(false);
      return;
    }

    const next: Record<string, Status> = {};
    const runnable: TrySource[] = [];
    for (const source of chosen) {
      if (source.key !== undefined && (store?.get(source.key.id) ?? '') === '') {
        next[source.name] = { state: 'skipped', reason: `Needs your ${source.key.label}.` };
      } else {
        next[source.name] = { state: 'loading' };
        runnable.push(source);
      }
    }
    setStatuses({ ...next });
    setResults([]);

    let relay: string | null = null;
    let relayError: string | null = null;
    if (runnable.some((source) => source.route !== 'browser-direct')) {
      try {
        relay = await relaySession();
      } catch (error) {
        relayError = `Relay unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
      }
    }

    const found: TryResult[] = [];
    const outcome = { failed: false };
    await Promise.all(
      runnable.map(async (source) => {
        if (source.route !== 'browser-direct' && relayError !== null) {
          outcome.failed = true;
          setStatuses((current) => ({
            ...current,
            [source.name]: { state: 'error', reason: relayError },
          }));
          return;
        }
        try {
          const rows = await searchOne(source, q, relay);
          found.push(...rows);
          setResults((current) => [...current, ...rows]);
          setStatuses((current) => ({
            ...current,
            [source.name]: { state: 'ok', count: rows.length, cached: false },
          }));
        } catch (error) {
          outcome.failed = true;
          const reason =
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'No answer in time.'
              : error instanceof Error
                ? error.message
                : 'Failed.';
          setStatuses((current) => ({ ...current, [source.name]: { state: 'error', reason } }));
        }
      }),
    );
    // Only complete result sets are cached; a partial one would hide a source that recovers.
    if (!outcome.failed && found.length > 0) {
      const ordered = TRY_SOURCES.flatMap((source) =>
        found.filter((r) => r.source === source.name),
      );
      void cache?.put(q, names, tier.perSource, ordered).catch(() => undefined);
    }
    setBusy(false);
  }

  async function ask(): Promise<void> {
    const key = llmKey.trim();
    if (key === '' || results.length === 0) return;
    const sources = pickForAnswer(
      TRY_SOURCES.flatMap((source) => results.filter((r) => r.source === source.name)),
    );
    setAnswerState('loading');
    setAnswer(null);
    try {
      const { url, init } = answerRequest(provider, key, model.trim(), searched, sources);
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
        throw new Error(
          typeof message === 'string' ? message : `The model answered ${String(response.status)}.`,
        );
      }
      const text = readAnswer(provider, body);
      if (text === '') throw new Error('The model returned no text.');
      setAnswer({ text, sources });
      setAnswerState('idle');
    } catch (error) {
      setAnswerState({ error: error instanceof Error ? error.message : 'The answer failed.' });
    }
  }

  const inputClass =
    'mt-1 w-full rounded border border-ink/40 bg-white px-3 py-2 text-ink focus:outline-2 focus:outline-offset-2';
  const buttonClass =
    'rounded bg-ink px-4 py-2 font-medium text-paper disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="mt-8 space-y-10">
      <section aria-labelledby="keys-heading">
        <h2 id="keys-heading" className="text-2xl font-semibold">
          Your keys
        </h2>
        <p className="mt-2 text-sm text-ink/80">
          Held in this page’s memory; a reload forgets them. Your browser sends them only to the
          provider they belong to (the CORE key goes through the relay, which passes it on and keeps
          nothing).
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Model provider
            <select
              className={inputClass}
              value={provider}
              onChange={(event) => {
                const value = event.target.value as Provider;
                setProvider(value);
                setModel(PROVIDERS[value].model);
                // A key belongs to the provider it was entered for: choosing another provider
                // forgets it, so it is never sent to a host it was not issued by.
                if (value !== provider) {
                  store?.set(LLM_KEY, '');
                  setLlmKey('');
                }
              }}
            >
              {Object.entries(PROVIDERS).map(([id, entry]) => (
                <option key={id} value={id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Model
            <input
              className={inputClass}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="block text-sm font-medium sm:col-span-2">
            {PROVIDERS[provider].label} API key
            <input
              className={inputClass}
              type="password"
              value={llmKey}
              onChange={(event) => {
                updateKey(LLM_KEY, event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            />
          </label>
          <label className="block text-sm font-medium sm:col-span-2">
            CORE API key (optional; without it CORE is skipped)
            <input
              className={inputClass}
              type="password"
              value={coreKey}
              onChange={(event) => {
                updateKey('core', event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={persist}
              onChange={(event) => {
                store?.setPersist(event.target.checked);
                setPersist(event.target.checked);
              }}
            />
            Keep my keys for this tab (sessionStorage, cleared when the tab closes)
          </label>
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            onClick={forgetKeys}
          >
            Forget keys
          </button>
        </div>
      </section>

      <section aria-labelledby="search-heading">
        <h2 id="search-heading" className="text-2xl font-semibold">
          Search
        </h2>
        <form className="mt-4 space-y-4" onSubmit={(event) => void search(event)}>
          <label className="block text-sm font-medium">
            Question or keywords
            <input
              className={inputClass}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              required
              maxLength={300}
            />
          </label>
          {SOURCE_GROUPS.map((group) => (
            <fieldset key={group.route} className="text-sm">
              <legend className="font-mono font-medium">{group.route}</legend>
              <p className="text-ink/80">{ROUTE_LABELS[group.route]}</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {group.sources.map((source) => (
                  <label key={source.name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(source.name)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(source.name);
                        else next.delete(source.name);
                        setSelected(next);
                      }}
                    />
                    {source.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div ref={widget} />
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className={buttonClass} disabled={busy || selected.size === 0}>
              {busy ? 'Searching…' : 'Search'}
            </button>
            <span className="text-sm text-ink/80" data-testid="tier">
              Device tier: {tier.name} ({String(tier.perSource)} per source
              {tier.cacheEntries > 0 ? ', recent searches cached on this device' : ', no cache'})
            </span>
          </div>
        </form>
      </section>

      {searched !== '' && (
        <section aria-labelledby="results-heading" aria-busy={busy}>
          <h2 id="results-heading" className="text-2xl font-semibold">
            Results
          </h2>
          <ul className="mt-2 space-y-1 text-sm" aria-live="polite">
            {TRY_SOURCES.filter((source) => statuses[source.name] !== undefined).map((source) => (
              <li
                key={source.name}
                data-source={source.name}
                data-state={statuses[source.name]?.state}
              >
                <span className="font-medium">{source.label}</span>
                <span className="text-ink/80"> · {source.route} · </span>
                {statusText(statuses[source.name] ?? { state: 'idle' })}
              </li>
            ))}
          </ul>

          <div className="mt-6 space-y-6">
            {TRY_SOURCES.map((source) => {
              const rows = results.filter((result) => result.source === source.name);
              if (rows.length === 0) return null;
              return (
                <div key={source.name}>
                  <h3 className="text-lg font-semibold">{source.label}</h3>
                  <ol className="mt-2 space-y-3">
                    {rows.map((result) => (
                      <li key={`${result.source}:${result.id}`} className="text-sm">
                        {webUrl(result.url) === null ? (
                          <span className="font-medium">{result.title}</span>
                        ) : (
                          <a
                            className="font-medium underline underline-offset-2"
                            href={webUrl(result.url) ?? undefined}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            {result.title}
                          </a>
                        )}
                        <p className="text-ink/80">
                          {[result.authors.slice(0, 3).join(', '), result.year]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        {result.snippet !== '' && (
                          <details className="mt-1">
                            <summary className="cursor-pointer underline underline-offset-2">
                              Read
                            </summary>
                            <p className="mt-1 text-ink/90">{result.snippet}</p>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {results.length > 0 && !busy && (
        <section aria-labelledby="answer-heading">
          <h2 id="answer-heading" className="text-2xl font-semibold">
            Cited answer
          </h2>
          <p className="mt-2 text-sm text-ink/80">
            Sends the question and up to eight results (one source at a time) to{' '}
            {PROVIDERS[provider].label} with your key, straight from your browser.
          </p>
          <button
            type="button"
            className={`mt-4 ${buttonClass}`}
            disabled={llmKey.trim() === '' || answerState === 'loading'}
            onClick={() => void ask()}
          >
            {answerState === 'loading' ? 'Asking…' : 'Answer with citations'}
          </button>
          {llmKey.trim() === '' && (
            <p className="mt-2 text-sm">Add a model key above to ask for an answer.</p>
          )}
          {typeof answerState === 'object' && (
            <p className="mt-2 text-sm" role="alert">
              {answerState.error}
            </p>
          )}
          {answer !== null && (
            <div className="mt-4" data-testid="answer">
              <p className="whitespace-pre-line">
                {citeParts(answer.text, answer.sources.length).map((part, index) =>
                  'cite' in part ? (
                    <a
                      key={index}
                      className="underline underline-offset-2"
                      href={`#cite-${String(part.cite)}`}
                    >
                      [{part.cite}]
                    </a>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )}
              </p>
              <ol className="mt-4 space-y-1 text-sm">
                {answer.sources.map((source, index) => (
                  <li key={`${source.source}:${source.id}`} id={`cite-${String(index + 1)}`}>
                    [{index + 1}]{' '}
                    {webUrl(source.url) === null ? (
                      source.title
                    ) : (
                      <a
                        className="underline underline-offset-2"
                        href={webUrl(source.url) ?? undefined}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {source.title}
                      </a>
                    )}{' '}
                    <span className="text-ink/80">({source.source})</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
