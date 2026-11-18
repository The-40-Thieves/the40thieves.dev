import { PAUSE_RETRY_AFTER_SECONDS } from '../../../../security/pause-flag.ts';

/**
 * The page half of the kill switch (P4-S5). `/alexandria/try/` is a prerendered file, so
 * wrangler.jsonc sends that path to the Worker first (`assets.run_worker_first`) and this gate
 * decides: paused, a static page with 503; otherwise the file from the assets binding, exactly as
 * before. Everything else under the path (the web manifest, the icon) is always the file.
 */
const TRY_PATHS = new Set(['/alexandria/try', '/alexandria/try/', '/alexandria/try/index.html']);

/** True for the page's own document, in the spellings the asset server accepts. */
export function isTryPage(pathname: string): boolean {
  return TRY_PATHS.has(pathname);
}

/** True for every path wrangler.jsonc routes to the Worker first for this gate. */
export function isGatedPath(pathname: string): boolean {
  return pathname === '/alexandria/try' || pathname.startsWith('/alexandria/try/');
}

/**
 * The paused page. No script, no stylesheet and no inline style: it must render under any
 * content policy, and it must not load the app it replaces.
 */
export const PAUSED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Try alexandria is paused</title>
</head>
<body>
<main>
<h1>Try alexandria is paused</h1>
<p>The in-browser search is switched off for now. Nothing is wrong with your keys or your browser. This page does not ask for, read or send any key.</p>
<p>Please come back later. Until then:</p>
<ul>
<li><a href="/alexandria/sources/">The routing matrix</a> lists every source and how it is reached.</li>
<li><a href="/alexandria-mcp/">alexandria-mcp</a> runs the same searches from your own machine.</li>
<li><a href="/">the40thieves.dev</a></li>
</ul>
</main>
</body>
</html>
`;

export interface PauseGateDeps {
  /** True while the operator has paused the relay and the page. */
  paused: () => Promise<boolean>;
  /** The static assets binding's fetch. */
  assets: (request: Request) => Promise<Response>;
  /** Adds the policy headers a Worker-generated response must carry. */
  stamp: (response: Response) => Response;
}

/**
 * Answer a request for a gated path. The flag is read only for the page's own document, on GET
 * and HEAD; every other request is the file.
 */
export async function gateTryPage(request: Request, deps: PauseGateDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const readsPage = request.method === 'GET' || request.method === 'HEAD';
  if (!readsPage || !isTryPage(pathname) || !(await deps.paused())) {
    return deps.assets(request);
  }
  return deps.stamp(
    new Response(request.method === 'HEAD' ? null : PAUSED_HTML, {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(PAUSE_RETRY_AFTER_SECONDS),
        'x-robots-tag': 'noindex',
      },
    }),
  );
}
