import { fileURLToPath } from 'node:url';

import { defineCollection } from 'astro:content';

import { githubLoader } from './loaders/github.ts';
import { changelogLoader, spotlightLoader } from './loaders/sanity.ts';

/**
 * Every public, non-fork, non-archived repository of the org, one entry each (P2-04).
 * Token: GITHUB_TOKEN (CI passes github.token; the GitHub App replaces it at P2-03).
 * Offline: HUB_GITHUB_FIXTURE=<path to a recorded response>.
 */
const projects = defineCollection({
  loader: githubLoader({
    org: 'The-40-Thieves',
    token: process.env.GITHUB_TOKEN,
    overridesDir: fileURLToPath(new URL('../content/hub/', import.meta.url)),
    fixturePath: process.env.HUB_GITHUB_FIXTURE,
  }),
});

/**
 * Editorial content from Sanity (P2-11): project cfnvp6ru, dataset `the40thieves`, published
 * documents only. Token: SANITY_READ_TOKEN (optional while the dataset is public).
 * Offline: HUB_SANITY_FIXTURE=<path to a recorded file keyed by type>.
 */
const sanity = {
  projectId: 'cfnvp6ru',
  dataset: 'the40thieves',
  token: process.env.SANITY_READ_TOKEN,
  fixturePath: process.env.HUB_SANITY_FIXTURE,
};
const spotlights = defineCollection({ loader: spotlightLoader(sanity) });
const changelog = defineCollection({ loader: changelogLoader(sanity) });

export const collections = { projects, spotlights, changelog };
