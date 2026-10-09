import baseConfig from './stryker.mcp.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...baseConfig,
  mutate: [
    'src/mcp/write-tools.ts',
    'src/mcp/write-tool-options.ts',
    'src/mcp/node-tools.ts',
    'src/mcp/risk-aggregation.ts',
    'src/mcp/secret-redaction.ts',
    'src/mcp/shared/secret-markers.ts',
    'src/mcp/write-mount.ts',
    'src/mcp/tool-input.ts',
    'src/mcp/schema-ref.ts',
    'src/mcp/2026-07-28/write.ts',
    'src/mcp/2026-07-28/request-state-codec.ts',
  ],
  incrementalFile: 'reports/stryker-mcp-write-incremental.json',
  htmlReporter: { fileName: 'reports/mutation/mcp-write/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mcp-write/mutation.json' },
};
