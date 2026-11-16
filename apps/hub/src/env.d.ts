/// <reference types="astro/client" />

/** Injected by `vite.define` in astro.config.ts; see src/lib/build-info.ts. */
declare const __BUILD_INFO__: import('@the40thieves/manifest').BuildInfo;

/** Worker bindings the on-demand routes read through `import { env } from 'cloudflare:workers'`. */
declare namespace Cloudflare {
  interface Env {
    /** Optional Worker secret: when set, `/healthz?boom=1` throws for requests carrying it. */
    HEALTHZ_BOOM_TOKEN?: string;
  }
}
