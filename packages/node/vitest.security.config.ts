import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/security/**/*.test.ts'],
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/security',
      include: ['src/security/**/*.ts'],
      thresholds: {
        branches: 90,
        functions: 98,
        lines: 95,
        statements: 90,
      },
    },
  },
});
