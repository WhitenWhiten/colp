/**
 * P4B-R05 fixed `server/discover` composition.
 *
 * Discovery is intentionally request-independent: it advertises exactly
 * `2026-07-28` and only the currently mounted empty capability candidate, with
 * a module-fixed server info. COLP validates and deep-freezes each result, so
 * repeated calls return fresh independent snapshots with no retained protocol
 * state.
 */
import {
  createMcp20260728DiscoverResult,
  validateMcp20260728DiscoverRequest,
  type Mcp20260728DiscoverResult,
} from '@know-n/colp/mcp';

/** Read-only MCP identity. Used when write is off and by write-off fixtures. */
export const PHASE4B_MCP_SERVER_INFO = Object.freeze({
  name: 'Known MCP Read',
  version: '0.1.0',
} as const);

/** Combined read+write identity when `KNOWN_FEATURE_MCP_WRITE` is on. */
export const PHASE4B_MCP_WRITE_SERVER_INFO = Object.freeze({
  name: 'Known MCP',
  version: '0.1.0',
} as const);

export function resolvePhase4bMcpServerInfo(writeEnabled: boolean):
  typeof PHASE4B_MCP_SERVER_INFO | typeof PHASE4B_MCP_WRITE_SERVER_INFO {
  return writeEnabled ? PHASE4B_MCP_WRITE_SERVER_INFO : PHASE4B_MCP_SERVER_INFO;
}

/**
 * Only capabilities mounted by this task candidate are declared. R11
 * implements resource subscriptions, resource list changes, and the
 * toolsListChanged opt-in; prompts are deliberately absent because no prompt
 * list route is mounted.
 */
export const PHASE4B_MCP_DISCOVERY_CAPABILITIES = Object.freeze({
  tools: Object.freeze({
    listChanged: true,
  }),
  resources: Object.freeze({
    subscribe: true,
    listChanged: true,
  }),
} as const);

/** Builds a fresh frozen discovery result; never accepts request-derived input. */
export function createPhase4bMcpDiscoverResult(
  writeEnabled = false,
): Mcp20260728DiscoverResult {
  return createMcp20260728DiscoverResult({
    serverInfo: resolvePhase4bMcpServerInfo(writeEnabled),
    capabilities: PHASE4B_MCP_DISCOVERY_CAPABILITIES,
  });
}

/** Delegates incoming `server/discover` request validation to COLP. */
export function validatePhase4bMcpDiscoverRequest(
  raw: unknown,
): { readonly ok: true } | { readonly ok: false; readonly issue: string } {
  return validateMcp20260728DiscoverRequest(raw);
}
