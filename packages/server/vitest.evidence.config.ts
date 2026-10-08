import { defineProject } from 'vitest/config';
import { EVIDENCE_INCLUDE } from './vitest.workspace-projects.js';

/**
 * Evidence-bound and externally provisioned suites. Default unit / static /
 * postgres shards exclude these files; `test:evidence:*` and dedicated
 * acceptance jobs own them.
 */
export default defineProject({
  test: {
    name: 'evidence',
    include: [...EVIDENCE_INCLUDE],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
