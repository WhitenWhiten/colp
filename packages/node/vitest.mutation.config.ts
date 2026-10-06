import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config.js';

export const mutationSandboxExcludes = [
  'tests/conformance/cfi-010-release-evidence-gate.test.ts',
  'tests/conformance/r02-mcp-write-progress-boundary-contract.test.ts',
  'tests/mcp/t01-quality-gates-contract.test.ts',
  'tests/sync/sync-core-quality-gates-contract.test.ts',
] as const;

export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: [...mutationSandboxExcludes],
  },
}));
