import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'vitest.unit.config.ts',
      'vitest.static.config.ts',
      'vitest.postgres.config.ts',
      'vitest.redis.config.ts',
      'vitest.browser.config.ts',
      'vitest.evidence.config.ts',
      'vitest.system.config.ts',
    ],
  },
});
