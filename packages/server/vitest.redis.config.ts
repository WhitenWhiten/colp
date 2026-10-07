import { defineProject } from 'vitest/config';
import { REDIS_INCLUDE } from './vitest.workspace-projects.js';

/**
 * Phase 4A Redis suites (Testcontainers `redis:7-alpine`, override
 * KNOW_REDIS_IMAGE). Timeouts are the union of the former per-slice
 * 120–180s / 180–300s budgets so `npm run test:redis-rate-limit` can
 * invoke `--project redis` without dropping the fail-closed Docker floor.
 * A missing Docker/Redis container is an environment failure — never a skip.
 */
export default defineProject({
  test: {
    name: 'redis',
    include: [...REDIS_INCLUDE],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
