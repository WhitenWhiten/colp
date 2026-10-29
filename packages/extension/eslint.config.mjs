import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    // A site adapter package's adapter.js is a function body that returns the adapter (docs/site-adapters/community-packages.md).
    files: ['tests/fixtures/site-adapters/*-package/adapter.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
