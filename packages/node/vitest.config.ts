import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/adapters/**/*.ts',
        'src/client/**/*.ts',
        'src/conformance/**/*.ts',
        'src/delivery/**/*.ts',
        'src/feed/**/*.ts',
        'src/mcp/**/*.ts',
        'src/schema/**/*.ts',
        'src/semantic/**/*.ts',
        'src/server/**/*.ts',
        'src/shared/**/*.ts',
        'src/sync/**/*.ts',
      ],
      exclude: ['src/**/generated/**'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        'src/adapters/**': { branches: 80, lines: 90, statements: 90 },
        'src/client/**': { branches: 92, lines: 95, statements: 95 },
        'src/conformance/**': { branches: 90, lines: 95, statements: 94 },
        // Feed is part of the default coverage surface; retain the repository
        // branch/function/line gates and make the statement policy explicit.
        'src/feed/**': { branches: 90, functions: 95, lines: 95, statements: 90 },
        'src/schema/**': { branches: 90, lines: 95, statements: 95 },
        'src/semantic/**': { branches: 94, lines: 97, statements: 97 },
        // V8 statement counts are enforced per domain so defensive fail-closed
        // branches do not distort the global gate across unrelated Profiles.
        'src/server/**': { branches: 90, lines: 95, statements: 93 },
        'src/shared/**': { branches: 82, lines: 90, statements: 90 },
        'src/mcp/**': {
          branches: 90,
          functions: 98,
          lines: 95,
          statements: 93,
        },
        'src/sync/**': {
          branches: 87,
          functions: 98,
          lines: 90,
          statements: 88,
        },
      },
    },
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
  },
});
