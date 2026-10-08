import { defineProject } from 'vitest/config';
import { STATIC_EXCLUDE, STATIC_INCLUDE } from './vitest.workspace-projects.js';

export default defineProject({
  test: {
    name: 'static',
    include: [...STATIC_INCLUDE],
    exclude: [...STATIC_EXCLUDE],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
