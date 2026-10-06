export const protocolVersion = '0.1' as const;
export const packageStatus = 'development' as const;

/**
 * Profiles are added only after their complete conformance suite passes.
 * mcp-read / mcp-write were restored after exact MCP
 * 2026-07-28 source-bound conformance evidence was accepted; the order
 * follows the delivery contract (core/publication -> publisher -> feed ->
 * sync -> mcp-read/mcp-write).
 */
export const supportedProfiles = Object.freeze([
  'core',
  'publication',
  'publisher',
  'feed',
  'sync',
  'mcp-read',
  'mcp-write',
] as const);
