import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { POSTGRES_EXCLUDE, POSTGRES_INCLUDE } from './vitest.workspace-projects.js';

export default defineProject({
  resolve: {
    alias: [{ find: /^@known\/sdk$/u,
      replacement: resolve(dirname(fileURLToPath(import.meta.url)), '../Known-Sdk/src/index.ts') }],
  },
  test: {
    name: 'postgres',
    include: [...POSTGRES_INCLUDE],
    exclude: [...POSTGRES_EXCLUDE],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
