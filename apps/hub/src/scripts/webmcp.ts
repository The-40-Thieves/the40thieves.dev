import { gatedToolNames } from '../lib/webmcp/gate.ts';
import { findModelContext } from '../lib/webmcp/model-context.ts';

/**
 * WebMCP bootstrap (P3-S4), a progressive layer. It does nothing unless the page carries an
 * Origin Trial token, declares tools and the browser has the API; only then is the registration
 * module fetched. In a browser without WebMCP this is the whole cost: two attribute reads, no
 * request and no console output.
 */
const names = gatedToolNames(document);
const modelContext = names.length > 0 ? findModelContext(document, navigator) : null;

if (modelContext !== null) {
  void import('../lib/webmcp/register.ts')
    .then(({ registerPageTools }) =>
      registerPageTools({
        modelContext,
        names,
        // Unbound `fetch` throws "Illegal invocation" when called as a property of another object.
        fetch: (input, init) => fetch(input, init),
      }),
    )
    .catch(() => undefined);
}
