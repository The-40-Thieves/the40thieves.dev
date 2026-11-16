import { createHandler, type WaitUntil } from '../src/handler.ts';
import { writeLog } from '../src/log.ts';
import { stackDeps, type StackEnv } from './stack-deps.ts';

/**
 * The relay's local-stack Worker entry (P4-S2), run only by wrangler.stack.jsonc and never
 * deployed: the production handler over the loopback-only dependencies in stack-deps.ts. Only the
 * default export lives here; workerd treats every named export of an entry as an entrypoint.
 */

let handler: ((request: Request, ctx: WaitUntil) => Promise<Response>) | undefined;

export default {
  fetch(request, env, ctx): Promise<Response> {
    handler ??= createHandler(stackDeps(env, writeLog));
    return handler(request, ctx);
  },
} satisfies ExportedHandler<StackEnv>;
