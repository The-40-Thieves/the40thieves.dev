import sources from '../../../data/sources.json' with { type: 'json' };

/** The slice of data/sources.json the allowlist reads. */
export interface SourcesFile {
  sources: { route: string; hosts: string[] }[];
}

/** The hosts of the `visitor-key-relay` entries, lower case. Nothing else is ever reachable through the relay. */
export function relayHosts(file: SourcesFile): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const source of file.sources) {
    if (source.route !== 'visitor-key-relay') continue;
    for (const host of source.hosts) hosts.add(host.toLowerCase());
  }
  return hosts;
}

/** Built once at module load from the committed file, so the deployed allowlist is the reviewed one. */
export const RELAY_HOSTS: ReadonlySet<string> = relayHosts(sources);
