/**
 * Turns a verified delivery into either a rebuild trigger or nothing. Only three GitHub events
 * and published-document changes in the hub dataset change what the hub renders; everything else
 * is acknowledged and dropped before any work is done.
 */

export interface Trigger {
  source: 'github' | 'sanity';
  /** `release.published`, `push`, `repository.publicized`, `document.<operation>`. */
  event: string;
  /** What changed, for the dispatch payload and the deploy log: repo and tag, ref, or document id. */
  subject: string;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repositoryOf(payload: Dict): { fullName: string; defaultBranch: string } | null {
  const repository = payload['repository'];
  if (!isDict(repository)) return null;
  const fullName = repository['full_name'];
  const defaultBranch = repository['default_branch'];
  if (typeof fullName !== 'string' || typeof defaultBranch !== 'string') return null;
  return { fullName, defaultBranch };
}

/**
 * `self` is the hub's own repository (`owner/name`): its pushes are dropped, because its deploy
 * already runs on push and a dispatch would only build the same commit twice.
 */
export function classifyGitHub(event: string, payload: unknown, self?: string): Trigger | null {
  if (!isDict(payload)) return null;
  const repository = repositoryOf(payload);
  if (repository === null) return null;
  const isSelf = self !== undefined && repository.fullName.toLowerCase() === self.toLowerCase();
  switch (event) {
    case 'release': {
      const release = payload['release'];
      if (payload['action'] !== 'published' || !isDict(release)) return null;
      if (release['draft'] === true || release['prerelease'] === true) return null;
      const tag = release['tag_name'];
      if (typeof tag !== 'string') return null;
      return {
        source: 'github',
        event: 'release.published',
        subject: `${repository.fullName} ${tag}`,
      };
    }
    case 'push': {
      const ref = payload['ref'];
      if (isSelf || ref !== `refs/heads/${repository.defaultBranch}`) return null;
      return { source: 'github', event: 'push', subject: `${repository.fullName} ${ref}` };
    }
    case 'repository': {
      if (payload['action'] !== 'publicized') return null;
      return { source: 'github', event: 'repository.publicized', subject: repository.fullName };
    }
    default:
      return null;
  }
}

const SANITY_OPERATIONS = new Set(['create', 'update', 'delete']);

/**
 * Sanity's GROQ-powered webhooks describe the change in headers, so the body never needs
 * parsing. Drafts are skipped here as well as in the webhook's own filter.
 */
export function classifySanity(headers: Headers, dataset: string): Trigger | null {
  const operation = headers.get('sanity-operation');
  const documentId = headers.get('sanity-document-id');
  if (headers.get('sanity-dataset') !== dataset) return null;
  if (operation === null || !SANITY_OPERATIONS.has(operation)) return null;
  if (documentId === null || documentId === '' || documentId.startsWith('drafts.')) return null;
  return { source: 'sanity', event: `document.${operation}`, subject: documentId };
}
