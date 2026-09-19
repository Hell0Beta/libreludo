import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      '.react-router/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      '*.config.js',
      // Local git worktrees are full copies of this repo; linting them just duplicates every
      // error against stale code.
      '.kilo/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: {
      react: { version: '19.2' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,

      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          allowExportNames: [
            'meta',
            'links',
            'loader',
            'clientLoader',
            'action',
            'clientAction',
            'shouldRevalidate',
            'handle',
            'headers',
            'ErrorBoundary',
            'HydrateFallback',
          ],
        },
      ],

      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      'react/no-unescaped-entities': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // server/ is plain ESM JavaScript with no TypeScript project; keep it in the type-unaware
    // config so `eslint .` lints it instead of failing to find it in a tsconfig.
    files: ['server/**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: { projectService: false },
    },
  },
  {
    files: ['*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
