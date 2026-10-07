import { defineProject } from 'vitest/config';
import { UNIT_EXCLUDE, UNIT_INCLUDE } from './vitest.workspace-projects.js';

export default defineProject({
  test: {
    name: 'unit',
    include: [...UNIT_INCLUDE],
    exclude: [...UNIT_EXCLUDE],
    maxWorkers: 4,
    testTimeout: 10_000,
    hookTimeout: 20_000,
  },
});
