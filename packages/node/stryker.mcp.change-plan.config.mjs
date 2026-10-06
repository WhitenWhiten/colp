import baseConfig from './stryker.mcp.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...baseConfig,
  mutate: ['src/mcp/change-plan.ts'],
  incrementalFile: 'reports/stryker-mcp-change-plan-incremental.json',
  htmlReporter: { fileName: 'reports/mutation/mcp-change-plan/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mcp-change-plan/mutation.json' },
};
