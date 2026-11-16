/**
 * The WebMCP entry point (P3-S4). This is the only file that names the browser API, because
 * the name has moved once already: the draft puts it on `Document`
 * (`document.modelContext`, webmachinelearning/webmcp), while Origin Trial builds from Chrome
 * 149 still ship the earlier `navigator.modelContext`. Everything else in the hub talks to
 * `ModelContextLike`.
 */

/** What the hub hands to `registerTool`: a subset of the draft's `ModelContextTool`. */
export interface PageToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  /**
   * Resolves to a JSON-serialisable value: the tool result, or `{ isError: true, message }` for
   * a failure the hub explained. The browser does the serialising, and reports a rejection to
   * the agent only as "tool rejected".
   */
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** The one method the hub uses. The draft returns a promise; earlier builds returned nothing. */
export interface ModelContextLike {
  registerTool(tool: PageToolRegistration, options?: { signal?: AbortSignal }): unknown;
}

function usable(value: unknown): value is ModelContextLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { registerTool?: unknown }).registerTool === 'function'
  );
}

/**
 * The page's model context, or null when the browser has none. Reading the attribute can throw
 * (a permissions policy that blocks the feature), which counts as not having it.
 */
export function findModelContext(doc: object, nav: object): ModelContextLike | null {
  for (const host of [doc, nav]) {
    try {
      const candidate = (host as { modelContext?: unknown }).modelContext;
      if (usable(candidate)) return candidate;
    } catch {
      // Blocked on this object; try the next.
    }
  }
  return null;
}
