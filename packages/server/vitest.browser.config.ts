import { defineProject } from 'vitest/config';
import { BROWSER_INCLUDE } from './vitest.workspace-projects.js';

/**
 * Phase 4A Playwright/Chromium suites. Each suite launches local Chromium
 * and local HTTP servers only; it never touches a real R2 endpoint.
 * Timeouts keep the former p08/p09 180s/120s floor.
 */
export default defineProject({
  test: {
    name: 'browser',
    include: [...BROWSER_INCLUDE],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
