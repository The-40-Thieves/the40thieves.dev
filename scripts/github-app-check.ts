import {
  createInstallationTokenProvider,
  findInstallationId,
  GITHUB_API,
} from '@the40thieves/github';

/**
 * CI gate for the GitHub App (P2-03 acceptance): mint an installation token from the
 * repository secrets, prove it is the App's own identity with a GraphQL `viewer` query, and
 * prove its write permission stops at the repositories it is installed on.
 *
 * Both write probes delete a branch that does not exist, so neither can change anything:
 * - on the hub repository the token has Contents write, and GitHub answers 422
 *   ("Reference does not exist"), which shows the permission reached the repository;
 * - on a public repository outside the installation GitHub answers 403 or 404, which shows
 *   the permission did not.
 * A 204 anywhere would mean the ref existed and was deleted, and a 422 outside the
 * installation would mean the App can write where it must not; both fail the job.
 */

const ORG = 'The-40-Thieves';
const INSTALLED_REPOSITORIES = new Set(['the40thieves.dev', '.github']);
const OUTSIDE_REPOSITORY = 'codecalc';
const EXPECTED_LOGIN = 'the40thieves-bot';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const credentials = { appId: required('GH_APP_ID'), privateKey: required('GH_APP_PRIVATE_KEY') };

const installationId = await findInstallationId(credentials, ORG);
const provider = createInstallationTokenProvider({ credentials, installationId });
const token = await provider.get();
// Never let the token reach the job log, whatever a later step prints.
console.log(`::add-mask::${token}`);

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'the40thieves-hub-ci',
  'X-GitHub-Api-Version': '2022-11-28',
};

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failures += 1;
}

// 1. The token is the App's own identity.
const viewerResponse = await fetch(`${GITHUB_API}/graphql`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ viewer { login __typename } }' }),
});
const viewer = (await viewerResponse.json()) as {
  data?: { viewer?: { login: string; __typename: string } };
  errors?: { message: string }[];
};
const login = viewer.data?.viewer?.login ?? '';
check(
  'viewer',
  viewerResponse.ok && login.startsWith(EXPECTED_LOGIN),
  `${String(viewerResponse.status)} login=${login || '(none)'} ${viewer.errors?.[0]?.message ?? ''}`.trim(),
);

// 2. The installation covers only the repositories it should.
const reposResponse = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
  headers,
});
const repos = (await reposResponse.json()) as { repositories?: { name: string }[] };
const names = (repos.repositories ?? []).map((repository) => repository.name).sort();
check(
  'installation repositories',
  reposResponse.ok && names.length > 0 && names.every((name) => INSTALLED_REPOSITORIES.has(name)),
  names.join(', ') || `(none) ${String(reposResponse.status)}`,
);

// 3. Write permission reaches the hub repository and stops outside the installation.
const probeRef = `heads/the40thieves-bot-negative-test-${String(Date.now())}`;
async function deleteMissingRef(repository: string): Promise<number> {
  const response = await fetch(`${GITHUB_API}/repos/${ORG}/${repository}/git/refs/${probeRef}`, {
    method: 'DELETE',
    headers,
  });
  await response.arrayBuffer();
  return response.status;
}

const insideStatus = await deleteMissingRef('the40thieves.dev');
check(
  'contents write inside the installation',
  insideStatus === 422,
  `status ${String(insideStatus)} (422 expected: permission reached the repository, ref absent)`,
);

const outsideStatus = await deleteMissingRef(OUTSIDE_REPOSITORY);
check(
  `contents write outside the installation (${OUTSIDE_REPOSITORY})`,
  outsideStatus === 403 || outsideStatus === 404,
  `status ${String(outsideStatus)} (403 or 404 expected)`,
);

if (failures > 0) {
  console.error(`${String(failures)} GitHub App check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(
    `GitHub App ${credentials.appId} (installation ${String(installationId)}) passes all checks`,
  );
}
