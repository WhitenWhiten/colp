import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import vitest from 'eslint-plugin-vitest';

const classQueryBan = [
  {
    selector: "CallExpression[callee.property.name='querySelector'][arguments.0.value=/^\\./]",
    message: 'Do not query tests by CSS class. Use data-testid, role, or aria attributes.',
  },
  {
    selector: "CallExpression[callee.property.name='querySelectorAll'][arguments.0.value=/^\\./]",
    message: 'Do not query tests by CSS class. Use data-testid, role, or aria attributes.',
  },
];

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'jsx-a11y': jsxA11y,
      'react-hooks': reactHooks,
    },
    settings: {
      'jsx-a11y': {
        components: { Link: 'a' },
      },
    },
    rules: {
      'no-debugger': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Small a11y set — not jsx-a11y/recommended (label/anchor rules are too noisy
      // for this codebase's form and Link patterns).
      'jsx-a11y/no-aria-hidden-on-focusable': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',
      'jsx-a11y/iframe-has-title': 'error',
      'jsx-a11y/no-access-key': 'error',
      // Pointer-only interactions must also work from the keyboard.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      'vitest/no-focused-tests': 'error',
      'no-restricted-syntax': ['warn', ...classQueryBan],
    },
  },
];
