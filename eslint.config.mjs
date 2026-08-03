// ESLint 9 flat config, ported from the strategy-maestro backend baseline.
//
// Deliberate deviation: the type-checked preset tiers are not enabled here.
// This runtime runs its sources natively (no emit) and `npm run typecheck`
// already gates the strict compiler surface; type-aware lint on top would
// re-litigate thousands of existing lines for marginal signal. Revisit only
// with a concrete bug class that plain recommended + tsc strict missed.

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '.generated/**', 'eslint.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Project convention (matches the maestro baseline).
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Tests and fixtures legitimately reach for `any` when modelling
      // untrusted wire payloads; the runtime should not.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier,
);
