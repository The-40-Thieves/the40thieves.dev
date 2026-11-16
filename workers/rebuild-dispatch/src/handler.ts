import { claimNonce, releaseNonce, requestRebuild, type Send } from './dispatch.ts';
import { classifyGitHub, classifySanity } from './events.ts';
import { verifyGitHubSignature, verifySanitySignature } from './signatures.ts';
import type { Store } from './store.ts';

/** The bindings the request handler reads; the Worker entry adds KV and the App credentials. */
export interface HandlerEnv {
  GITHUB_WEBHOOK_SECRET?: string | undefined;
  SANITY_WEBHOOK_SECRET?: string | undefined;
  SANITY_DATASET?: string | undefined;
  /** The hub repository; its own pushes are not dispatched (see classifyGitHub). */
  DISPATCH_OWNER?: string | undefined;
  DISPATCH_REPO?: string | undefined;
}

export interface HandlerDeps {
  store: Store;
  send: Send;
  now: () => number;
  /** Structured log line; never given a body or a secret. */
  log: (entry: Record<string, unknown>) => void;
}

/** Webhook payloads are small; anything larger is not a delivery we want to read. */
export const MAX_BODY_BYTES = 1024 * 1024;

const ROUTES = new Set(['/github', '/sanity']);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return Promise.resolve(null);
  return request
    .text()
    .then((text) => (new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text));
}

export async function handleRequest(
  request: Request,
  env: HandlerEnv,
  deps: HandlerDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') return json(200, { ok: true });
  if (!ROUTES.has(pathname)) return json(404, { error: 'not found' });
  if (request.method !== 'POST') {
    return json(405, { error: 'method not allowed' }, { allow: 'POST' });
  }
  const route = pathname === '/github' ? 'github' : 'sanity';
  const secret = route === 'github' ? env.GITHUB_WEBHOOK_SECRET : env.SANITY_WEBHOOK_SECRET;
  if (!secret || (route === 'sanity' && !env.SANITY_DATASET)) {
    deps.log({ route, reason: 'unconfigured' });
    return json(500, { error: 'webhook not configured' });
  }
  const body = await readBody(request);
  if (body === null) return json(413, { error: 'payload too large' });

  const delivery =
    route === 'github'
      ? request.headers.get('x-github-delivery')
      : request.headers.get('idempotency-key');
  const event = route === 'github' ? request.headers.get('x-github-event') : 'document';
  if (!delivery || !event) return json(400, { error: 'missing delivery headers' });

  if (route === 'github') {
    const header = request.headers.get('x-hub-signature-256');
    if (!(await verifyGitHubSignature(secret, body, header))) {
      deps.log({ route, delivery, event, reason: 'bad-signature' });
      return json(401, { error: 'bad signature' });
    }
  } else {
    const header = request.headers.get('sanity-webhook-signature');
    const result = await verifySanitySignature(secret, body, header, deps.now());
    if (!result.ok) {
      const reason = result.reason === 'invalid' ? 'bad-signature' : result.reason;
      deps.log({ route, delivery, reason });
      return json(401, { error: 'bad signature' });
    }
  }

  if (!(await claimNonce(deps.store, route, delivery))) {
    deps.log({ route, delivery, event, reason: 'replay' });
    return json(409, { status: 'replay' });
  }

  const trigger =
    route === 'github'
      ? classifyGitHub(event, parseJson(body), selfRepository(env))
      : classifySanity(request.headers, env.SANITY_DATASET ?? '');
  if (trigger === null) {
    deps.log({ route, delivery, event, status: 'ignored' });
    return new Response(null, { status: 204 });
  }

  try {
    const status = await requestRebuild(deps.store, trigger, deps.send);
    deps.log({ route, delivery, ...trigger, status });
    return json(202, { status });
  } catch (error) {
    // Let the sender's redelivery button work: the delivery id is free again.
    await releaseNonce(deps.store, route, delivery);
    deps.log({ route, delivery, ...trigger, reason: 'dispatch-failed', message: String(error) });
    return json(502, { error: 'dispatch failed' });
  }
}

function selfRepository(env: HandlerEnv): string | undefined {
  return env.DISPATCH_OWNER && env.DISPATCH_REPO
    ? `${env.DISPATCH_OWNER}/${env.DISPATCH_REPO}`
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
