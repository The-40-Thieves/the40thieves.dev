import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';

/** Shared flat config: strict type-checked TypeScript plus Astro recommended rules. */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.astro/**', '**/node_modules/**', '**/.wrangler/**'] },
  ...tseslint.configs.strictTypeChecked,
  ...astro.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    // astro-eslint-parser does not support projectService; point it at the nearest tsconfig.
    files: ['**/*.astro'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: true,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
