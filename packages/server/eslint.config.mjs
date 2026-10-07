import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [{
  ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'tests/fixtures/**'],
}, {
  files: ['**/*.ts'],
  languageOptions: {
    parser,
  },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'no-dupe-keys': 'error',
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@know-n/colp',
        message: 'The COLP package root is metadata-only; import business APIs from their owning subpath.',
      }],
    }],
  },
}, {
  files: ['src/**/*.ts', 'worker/**/*.ts'],
  languageOptions: {
    parser,
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', {
      checksVoidReturn: { arguments: false, attributes: false },
    }],
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
      message: 'Use explicit propagation/reporting or the rationale-bearing best-effort Promise boundary.',
    }],
  },
}];
