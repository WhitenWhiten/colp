import { randomUUID } from 'node:crypto';
import { Mcp20260728RequestError } from '@know-n/colp/mcp';
import type { ScopeName } from '@know-n/colp/types';
import { MCP_OWN_DATA_DEFAULT_BUDGET, snapshotMcpOwnData } from './own-data.js';
import { createPhase4bMcpChangePlanPlanner, computePhase4bMcpCanonicalDigest, phase4bMcpPlanSummary,
  type Phase4bMcpChangePlanPlanner, type Phase4bMcpChangePlanPlannerOptions, type Phase4bMcpStoredPlan,
  type Phase4bMcpPlanOperation, type Phase4bMcpNodeCreateOperation } from './change-plan-planner.js';

export type PlannedNodeCreate = Phase4bMcpNodeCreateOperation & { readonly plannedNodeId?: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new Mcp20260728RequestError('invalid_params', message, { code: 'invalid_organize_plan' }); };
const id = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(value) ? value : invalid('An opaque resource or reference id is required.');
export const isOrganizePlanRequest = (input: unknown): boolean => object(input) && Object.hasOwn(input, 'collectionId');

/** Assemble validated catalog operations in memory and persist exactly one approval. No partial plans or writes escape. */
export function createOrganizePlanPlanner(options: Phase4bMcpChangePlanPlannerOptions): Phase4bMcpChangePlanPlanner {
  const catalog = createPhase4bMcpChangePlanPlanner(options);
  return { async plan(raw, binding) {
    if (!isOrganizePlanRequest(raw) || !object(raw) || !Array.isArray(raw.operations)) return catalog.plan(raw, binding);
    const input = snapshotMcpOwnData(raw, MCP_OWN_DATA_DEFAULT_BUDGET) as Record<string, unknown>;
    if (Object.keys(input).some(key => !['collectionId', 'operations', 'reason', 'dryRun'].includes(key)) || input.dryRun !== true)
      return invalid('An organize plan requires collectionId, operations, reason and dryRun=true only.');
    const collectionId = id(input.collectionId), requests = input.operations as unknown[];
    if (!requests.length || requests.length > 50) return invalid('An organize plan contains between 1 and 50 operations.');
    const refs = new Map<string, { id: string; ancestor: string; title: string }>();
    const parts: Phase4bMcpStoredPlan[] = [], operations: Phase4bMcpPlanOperation[] = [];
    const baseRevisions: Record<string, string> = {};
    const local = createPhase4bMcpChangePlanPlanner({ ...options, planStore: {
      save: plan => { parts.push(plan); }, get: planId => parts.find(plan => plan.planId === planId),
    } });
    for (const request of requests) {
      if (!object(request)) return invalid('Each operation must be an object.');
      const { type, ref, parentRef, ...fields } = request;
      const allowed = type === 'create_node' ? ['type', 'ref', 'parentId', 'parentRef', 'node']
        : type === 'move_node' ? ['type', 'nodeId', 'parentId', 'parentRef', 'position'] : ['type', 'nodeId'];
      if (Object.keys(request).some(key => !allowed.includes(key))) return invalid('An organize operation contains unsupported fields.');
      const tool = type === 'create_node' ? 'nodes.create' : type === 'move_node' ? 'nodes.move'
        : type === 'delete_subtree' ? 'nodes.delete_subtree' : invalid('Organize plans support create_node, move_node and delete_subtree.');
      if (ref !== undefined && type !== 'create_node') return invalid('Only a created folder may declare a reference.');
      if (ref !== undefined && refs.has(id(ref))) return invalid('A folder reference may only be declared once.');
      if (parentRef !== undefined && (type === 'delete_subtree' || fields.parentId !== undefined))
        return invalid('Choose either parentId or parentRef for a create or move.');
      const parent = parentRef === undefined ? undefined : refs.get(id(parentRef));
      if (parentRef !== undefined && !parent) return invalid('parentRef must name an earlier created folder.');
      // The existing ancestor proves destination ownership/range. The new folder itself is only created at commit.
      const planned = await local.plan({ ...fields, collectionId, ...(parent ? { parentId: parent.ancestor } : {}),
        tool, reason: input.reason, dryRun: true }, binding);
      for (const [key, revision] of Object.entries(planned.baseRevisions)) {
        if (baseRevisions[key] !== undefined && baseRevisions[key] !== revision) return invalid('The collection changed while planning. Read it again.');
        baseRevisions[key] = revision;
      }
      for (const operation of planned.operations) {
        if (operation.type === 'create_node') {
          const made: PlannedNodeCreate = { ...operation, plannedNodeId: `node-${randomUUID()}`,
            payload: { ...operation.payload, ...(parent ? { parentId: parent.id } : {}) } };
          operations.push(made);
          if (ref !== undefined) {
            if (operation.payload.node.kind !== 'folder') return invalid('Only folders may be referenced as destinations.');
            refs.set(id(ref), { id: made.plannedNodeId!, ancestor: parent?.ancestor ?? operation.payload.parentId,
              title: parent ? `${parent.title} / ${operation.payload.node.title}` : operation.payload.node.title });
          }
        } else if (operation.type === 'move_node' && parent) {
          operations.push({ ...operation, sourceParentId: operation.sourceParentId ?? operation.parentId, parentId: parent.id, impact: `${operation.impact}; destination is the new folder “${parent.title}”` });
        } else operations.push(operation);
      }
      if (operations.length > 50) return invalid('An organize plan may expand to at most 50 operations.');
    }
    const requiredScopes = [...new Set(parts.flatMap(part => part.requiredScopes))] as ScopeName[];
    const risk = parts.some(part => part.risk === 'high') ? 'high' as const : 'medium' as const;
    const impact = await options.impact.assessImpact(operations);
    const first = parts[0]!, planId = options.ids?.nextPlanId() ?? `plan-${randomUUID()}`;
    const stored: Phase4bMcpStoredPlan = { ...first, planId, operations, baseRevisions, requiredScopes, risk, impact,
      requiresApproval: true, approvalMethod: 'out_of_band', approvalUri: `${options.approvalBaseUri.replace(/\/$/u, '')}/${encodeURIComponent(planId)}`,
      summary: phase4bMcpPlanSummary(operations, impact),
      operationsDigest: computePhase4bMcpCanonicalDigest({ operations, binding: first.binding, baseRevisions, requiredScopes, risk, impact }) };
    await options.planStore.save(stored);
    return { ...stored, mode: 'awaiting_approval', target: { kind: 'collection', serverUuid: options.serverUuid, collectionId } };
  } };
}
