import { WEBMCP_TOOLS_META } from '@the40thieves/manifest/webmcp';

/** The part of `Document` the gate reads; the tests pass a fake. */
export interface MetaDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The tool names this page may register (P3-S4): what the layout declared in the tools
 * meta, and only when the page also carries an Origin Trial token meta. No token meta, no tools:
 * removing the tokens from `security/origin-trials.json` switches the feature off everywhere.
 */
export function gatedToolNames(doc: MetaDocument): string[] {
  if (doc.querySelector('meta[http-equiv="origin-trial" i]') === null) return [];
  const content =
    doc.querySelector(`meta[name="${WEBMCP_TOOLS_META}"]`)?.getAttribute('content') ?? '';
  return content.split(/\s+/).filter((name) => name !== '');
}
