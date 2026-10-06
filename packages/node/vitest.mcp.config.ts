import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/mcp/**/*.test.ts'],
    pool: 'threads',
  },
});
