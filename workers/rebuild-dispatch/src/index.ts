import {
  createInstallationTokenProvider,
  type InstallationTokenProvider,
} from '@the40thieves/github';

import { createGitHubDispatcher, flushPending, type Send } from './dispatch.ts';
import { handleRequest, type HandlerEnv } from './handler.ts';

/**
 * `rebuild-dispatch` (P2-09): the Worker behind hooks.the40thieves.dev.
 *
 * A verified GitHub or Sanity webhook becomes one `repository_dispatch` of type `rebuild` on
 * the hub repository, sent as the App installation. Signatures, replay protection, the event
 * filter and the debounce live in the pure modules beside this file; this file only wires
 * bindings to them.
 */
export interface Env extends HandlerEnv {
  REBUILD_KV: KVNamespace;
  /** Public identifiers, set as vars. */
  GH_APP_ID?: string | undefined;
  GH_APP_INSTALLATION_ID?: string | undefined;
  DISPATCH_OWNER?: string | undefined;
  DISPATCH_REPO?: string | undefined;
  /** The App's PEM private key, a Worker secret. */
  GH_APP_PRIVATE_KEY?: string | undefined;
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

/** One token provider per isolate: the fifty-minute cache survives across requests. */
let provider: InstallationTokenProvider | undefined;

function sender(env: Env): Send {
  const { GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY, DISPATCH_OWNER, DISPATCH_REPO } =
    env;
  if (!GH_APP_ID || !GH_APP_INSTALLATION_ID || !GH_APP_PRIVATE_KEY) {
    return () => Promise.reject(new Error('GitHub App credentials are not configured'));
  }
  if (!DISPATCH_OWNER || !DISPATCH_REPO) {
    return () => Promise.reject(new Error('dispatch target is not configured'));
  }
  const tokens = (provider ??= createInstallationTokenProvider({
    credentials: { appId: GH_APP_ID, privateKey: GH_APP_PRIVATE_KEY },
    installationId: Number(GH_APP_INSTALLATION_ID),
    // The narrowest grant that can send repository_dispatch: this repository, Contents write.
    scope: { repositories: [DISPATCH_REPO], permissions: { contents: 'write' } },
  }));
  const dispatch = createGitHubDispatcher({
    owner: DISPATCH_OWNER,
    repo: DISPATCH_REPO,
    token: () => tokens.get(),
  });
  return async (trigger) => {
    try {
      await dispatch(trigger);
    } catch (error) {
      // A rejected token is dropped so the next delivery mints a fresh one.
      if (String(error).includes('HTTP 401')) tokens.invalidate();
      throw error;
    }
  };
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env, {
      store: env.REBUILD_KV,
      send: sender(env),
      now: Date.now,
      log,
    });
  },
  async scheduled(_controller, env): Promise<void> {
    const status = await flushPending(env.REBUILD_KV, sender(env));
    if (status !== 'idle') log({ cron: 'flush', status });
  },
} satisfies ExportedHandler<Env>;
