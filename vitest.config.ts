import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workers keep their tests beside their source; they run under Node with WebCrypto and an
    // in-memory store, so the root suite covers them too.
    include: ['tests/**/*.test.ts', 'workers/*/tests/**/*.test.ts'],
  },
});
