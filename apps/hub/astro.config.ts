import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

import { resolveBuildInfo } from './src/lib/build-info.ts';

import csp from '../../security/csp.directives.json' with { type: 'json' };

type AstroConfig = NonNullable<Parameters<typeof defineConfig>[0]>;
type CspConfig = Exclude<NonNullable<AstroConfig['security']>['csp'], boolean | undefined>;
type CspDirectives = NonNullable<CspConfig['directives']>;

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: 'https://the40thieves.dev',
  adapter: cloudflare({ imageService: 'compile' }),
  // Every page is prerendered; without this the adapter injects a SESSION KV binding that
  // wrangler deploy would then require a namespace id for.
  session: false,
  integrations: [
    react(),
    // Only real pages belong in the sitemap; the 404 route is excluded.
    sitemap({ filter: (page) => !page.endsWith('/404/') }),
  ],
  // Shiki emits inline styles that break the hashed CSP; Prism does not.
  markdown: { syntaxHighlight: 'prism' },
  vite: {
    plugins: [
      tailwindcss(),
      {
        // Source maps for the server build only (P2-12): wrangler chains them into the Worker
        // bundle's map, the deploy job uploads that to Sentry, and nothing under dist/client
        // ever carries one.
        name: 'hub-ssr-sourcemaps',
        // Only when the deploy job asks (HUB_SOURCEMAPS=1): every other build, and the leak
        // gate that runs on it, sees no .map at all.
        config: (_config, env) =>
          env.isSsrBuild === true && process.env['HUB_SOURCEMAPS'] === '1'
            ? { build: { sourcemap: true } }
            : {},
      },
    ],
    // Prerendering runs inside workerd, so the commit and time are resolved here in Node once.
    define: { __BUILD_INFO__: JSON.stringify(resolveBuildInfo()) },
  },
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: csp.directives as CspDirectives,
    },
  },
});
