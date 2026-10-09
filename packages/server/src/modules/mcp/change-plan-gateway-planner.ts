import { MCP_OWN_DATA_DEFAULT_BUDGET, snapshotMcpOwnData } from './own-data.js';
/**
 * Host planner for the COLP write gateway's `changes.plan`.
 *
 * The gateway's generic planner stamps an operations-only digest, but Commit
 * here verifies the stronger Phase4b canonical digest. This planner runs the
 * generic planning logic over a store that stamps the Phase4b digest as the
 * Plan is first persisted, so no Plan is ever visible with a digest the
 * Commit verifier would reject.
 */
import {
  createChangePlanService,
  type McpAuthenticatedAuthorizationBinding,
  type McpChangePlanServiceOptions,
  type McpChangePlanStorePort,
  type McpStoredPlan,
} from '@know-n/colp/mcp';
import type { ChangePlan } from '@know-n/colp/types';

import { computePhase4bMcpStoredPlanDigest } from './change-plan-service.js';

export interface Phase4bMcpGatewayPlanner {
  readonly plan: (
    request: unknown,
    binding: McpAuthenticatedAuthorizationBinding,
    authorizedScopes?: readonly string[],
  ) => Promise<ChangePlan>;
}

export function createPhase4bMcpGatewayPlanner(
  options: McpChangePlanServiceOptions,
): Phase4bMcpGatewayPlanner {
  const { planStore } = options;
  const digestStampingStore: McpChangePlanStorePort = Object.freeze({
    save: (plan: McpStoredPlan) => planStore.save(Object.freeze({
      ...plan,
      operationsDigest: computePhase4bMcpStoredPlanDigest(plan),
    })),
    get: (planId: string) => planStore.get(planId),
    update: (plan: McpStoredPlan) => planStore.update(plan),
  });
  const service = createChangePlanService({ ...options, planStore: digestStampingStore });
  return Object.freeze({
    async plan(
      request: unknown,
      binding: McpAuthenticatedAuthorizationBinding,
      authorizedScopes?: readonly string[],
    ) {
      const input = snapshotMcpOwnData(request, MCP_OWN_DATA_DEFAULT_BUDGET) as { operations?: readonly unknown[] };
      // Keep the host's existence-ambiguous revision rejection, before the SDK
      // sanitizes arbitrary dependency failures into an internal error.
      for (const operation of input.operations ?? []) {
        if (operation && typeof operation === 'object' && (operation as { type?: string }).type === 'set_visibility') {
          await options.revisions.resolveBaseRevisions(operation as Parameters<typeof options.revisions.resolveBaseRevisions>[0], binding);
        }
      }
      return Reflect.apply(
        service.plan,
        service,
        [input, binding, authorizedScopes],
      ) as Promise<ChangePlan>;
    },
  });
}
