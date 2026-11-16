/**
 * Maps a pull request preview host on .dev to the hub's preview alias and proxies the request.
 *
 * `pr-<n>-preview.the40thieves.dev` is served by the hub version uploaded with `--preview-alias pr-<n>`.
 * That version only answers on the account's workers.dev subdomain, which this repository never
 * names: the suffix arrives as the PREVIEW_ORIGIN_SUFFIX secret, and every response that could
 * point back at it (a redirect) is rewritten to the public host.
 */

export interface GatewayEnv {
  /** `-hub.<subdomain>.workers.dev`, a Worker secret. */
  PREVIEW_ORIGIN_SUFFIX?: string | undefined;
}

export type Fetcher = (request: Request) => Promise<Response>;

const HOST = /^pr-([1-9]\d{0,5})-preview\.the40thieves\.dev$/;
const SUFFIX = /^-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/;

/** The largest request body forwarded. The hub's biggest accepted body is 16 KiB (/csp-report). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Answers on any -preview host, so a deploy can check the secret without a live alias. */
export const HEALTH_PATH = '/__gateway/healthz';

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/** True when the suffix secret has the only shape the gateway will fetch from. */
export function suffixIsValid(suffix: string | undefined): suffix is string {
  return suffix !== undefined && SUFFIX.test(suffix);
}

/** Reads at most `limit` bytes of a body; null when it is larger. */
async function readLimited(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (request.body === null) return new ArrayBuffer(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** The pull request number a host serves, or null when the host is not a preview host. */
export function previewNumber(hostname: string): string | null {
  return HOST.exec(hostname.toLowerCase())?.[1] ?? null;
}

export async function handleRequest(
  request: Request,
  env: GatewayEnv,
  fetcher: Fetcher = (upstream) => fetch(upstream),
): Promise<Response> {
  const url = new URL(request.url);
  const suffix = env.PREVIEW_ORIGIN_SUFFIX;
  const isPreviewZone = url.hostname.toLowerCase().endsWith('-preview.the40thieves.dev');
  if (url.pathname === HEALTH_PATH && isPreviewZone) {
    return suffixIsValid(suffix) ? text(200, 'ok') : text(503, 'Preview gateway is not configured');
  }

  const pr = previewNumber(url.hostname);
  if (pr === null) return text(404, 'Not found');
  if (!suffixIsValid(suffix)) return text(503, 'Preview gateway is not configured');

  const publicHost = url.host;
  const upstreamHost = `pr-${pr}${suffix}`;
  // The origin is fixed and the path is assigned, never parsed: a path such as `//evil.test/x`
  // stays a path on the alias instead of becoming a new authority.
  const upstream = new URL(`https://${upstreamHost}`);
  upstream.pathname = url.pathname;
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // Buffered with a cap: preview traffic is small, and a buffered body needs no duplex mode.
  const body = hasBody ? await readLimited(request, MAX_BODY_BYTES) : null;
  if (hasBody && body === null) return text(413, 'Request body too large');
  const response = await fetcher(
    new Request(upstream, { method: request.method, headers, body, redirect: 'manual' }),
  );

  const out = new Headers(response.headers);
  const location = out.get('location');
  if (location !== null) {
    const target = new URL(location, upstream);
    if (target.host === upstreamHost) {
      target.protocol = 'https:';
      target.host = publicHost;
      out.set('location', target.toString());
    }
  }
  out.set('x-robots-tag', 'noindex, nofollow');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}
