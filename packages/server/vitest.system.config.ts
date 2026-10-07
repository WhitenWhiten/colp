import { defineProject } from 'vitest/config';
import { SYSTEM_INCLUDE } from './vitest.workspace-projects.js';

export default defineProject({
  test: {
    name: 'system',
    include: [...SYSTEM_INCLUDE],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
