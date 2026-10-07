/**
 * P4B-R05 Modern result/error mapping with fixed Phase 4B server info.
 *
 * All Modern results stamped by this host use the same module-fixed server
 * identity, never a request-derived value. Error normalization delegates to
 * COLP so reserved `-32020/-32021/-32022` codes survive and internal detail
 * collapses to low-sensitivity `-32603`.
 */
import {
  createMcp20260728Result,
  normalizeMcp20260728Error,
  type Mcp20260728Result,
  type Mcp20260728ResultInput,
  type Mcp20260728WireError,
} from '@know-n/colp/mcp';
import { resolvePhase4bMcpServerInfo } from './discovery.js';

export const normalizePhase4bMcpError = normalizeMcp20260728Error;

/** Builds a frozen Modern result and always overrides serverInfo to the host identity. */
export function createPhase4bMcpResult(
  input: Mcp20260728ResultInput,
  writeEnabled = false,
): Mcp20260728Result {
  return createMcp20260728Result({
    ...input,
    serverInfo: resolvePhase4bMcpServerInfo(writeEnabled),
  });
}

export type { Mcp20260728Result, Mcp20260728ResultInput, Mcp20260728WireError };
