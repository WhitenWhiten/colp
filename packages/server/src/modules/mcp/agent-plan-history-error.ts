import { McpChangePlanError } from '@know-n/colp/mcp';
import {
  COLLECTION_TREE_VERSION_MAX_BYTES,
  CollectionVersionCapacityError,
} from '../collections/index.js';

// History capacity is part of the plan's impact budget. Keep the existing
// COLP error code so the pinned SDK preserves it through commit rollback.
export const MCP_PLAN_IMPACT_EXCEEDED_MESSAGE =
  `This plan exceeds the server's change or history capacity. Collection history supports at most ${COLLECTION_TREE_VERSION_MAX_BYTES / 1024 / 1024} MiB of serialized tree data per snapshot. Nothing was changed. Cancel this plan and reduce the collection size or plan impact before trying again.`;

export function rethrowAgentPlanHistoryError(error: unknown): never {
  if (error instanceof CollectionVersionCapacityError) {
    throw new McpChangePlanError('impact_exceeded', MCP_PLAN_IMPACT_EXCEEDED_MESSAGE);
  }
  throw error;
}
