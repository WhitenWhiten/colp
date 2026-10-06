/**
 * Exact MCP wire protocol version supported by COLP (migration decision §7.2).
 *
 * COLP accepts only the stateless MCP `2026-07-28` baseline. There is no
 * configurable protocol version and no version factory: `MCP_PROTOCOL_VERSION`
 * and `supportedMcpProtocolVersions` are the single source of truth shared by
 * the schema (`features.mcp.protocolVersion` const), generated types,
 * conformance tooling and runtime adapters. Older protocol semantics may only
 * appear as rejection samples in migration notes.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;

/**
 * The only supported MCP protocol version. Kept frozen so callers cannot
 * mutate the advertised supported set at runtime.
 */
export const supportedMcpProtocolVersions = Object.freeze(['2026-07-28']) as readonly ['2026-07-28'];
