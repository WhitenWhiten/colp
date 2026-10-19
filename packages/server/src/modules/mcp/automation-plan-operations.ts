import type { McpAuthenticatedAuthorizationBinding, McpStoredPlan } from '@know-n/colp/mcp';
import type { OperationResult } from '@know-n/colp/types';
import { canonicalCommandFingerprint } from '../commands/index.js';
import { createAnnotation, updateCollectionNode, moveCollectionNode, type AnnotationMutationPorts, type ProductCollectionCanonicalPorts } from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';

/** Host-built operations only. Generic changes.plan never accepts these private shapes. */
export interface AutomationPlanOperation {
  type: 'update_node' | 'create_annotation' | 'move_node'; collectionId: string; nodeId: string;
  commandId: string; operationId: string; ruleId: string; jobId: string; runId: string;
  parentId?: string; sourceParentId?: string; tags?: string[]; previousTags?: string[]; text?: string; annotationId?: string; creator?: { id: string; name: string };
}
export function isAutomationPlanOperation(value: unknown): value is AutomationPlanOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<AutomationPlanOperation>;
  if (!['collectionId','nodeId','commandId','operationId','ruleId','jobId','runId'].every(key => {
    const item=Reflect.get(v,key);return typeof item==='string' && item.length>0;
  })) return false;
  switch(v.type) {
    case 'move_node': return typeof v.parentId==='string' && !!v.parentId && typeof v.sourceParentId==='string' && !!v.sourceParentId;
    case 'update_node': return Array.isArray(v.tags) && v.tags.every(tag=>typeof tag==='string');
    case 'create_annotation': return typeof v.text==='string' && !!v.text && typeof v.annotationId==='string'
      && typeof v.creator?.id==='string' && typeof v.creator.name==='string';
    default: return false;
  }
}
export async function executeAutomationPlanOperation(operation: AutomationPlanOperation, plan: McpStoredPlan,
  binding: McpAuthenticatedAuthorizationBinding, ports: ProductCollectionCanonicalPorts, annotations: AnnotationMutationPorts): Promise<OperationResult> {
  const actor = { principalId: binding.principalId,subjectId: requireMcpAccountSubjectId(),principalType: 'account' as const };
  const context = { origin: 'automation' as const,rootRunId: operation.runId,stageId: operation.jobId,hopCount: 1 };
  const command = { commandId: operation.commandId,fingerprint: canonicalCommandFingerprint({ method: 'PLAN',route: plan.planId,mediaType: 'application/json',body: operation }) };
  let revision: string;
  if (operation.type === 'move_node') {
    if (!operation.parentId || !operation.sourceParentId) throw new Error('Automation move is incomplete');
    const wrapped = { ...ports,canonical: { ...ports.canonical,execute: (input: Parameters<typeof ports.canonical.execute>[0]) => ports.canonical.execute({ ...input,automationContext: context }) } };
    const result = await moveCollectionNode(wrapped,{ actor,command,collectionId: operation.collectionId,nodeId: operation.nodeId,
      ifMatch: plan.baseRevisions['node.'+operation.nodeId]!,newParentId: operation.parentId,afterId: null,beforeId: null,
      baseSourceParentRevision: plan.baseRevisions['children.'+operation.sourceParentId]!,baseTargetParentRevision: plan.baseRevisions['children.'+operation.parentId]!,operationId: operation.operationId });
    if (result.kind !== 'moved') throw new Error('Automation move did not commit');
    revision = result.node.revision;
  } else if (operation.type === 'update_node') {
    if (!operation.tags) throw new Error('Automation tag operation lacks a closed patch');
    const wrapped = { ...ports,canonical: { ...ports.canonical,execute: (input: Parameters<typeof ports.canonical.execute>[0]) =>
      ports.canonical.execute({ ...input,automationContext: context }) } };
    const result = await updateCollectionNode(wrapped,{ actor,command,collectionId: operation.collectionId,nodeId: operation.nodeId,
      ifMatch: `"${plan.baseRevisions['node.'+operation.nodeId]}"`,patch: { tags: operation.tags },operationId: operation.operationId });
    if (result.kind !== 'updated') throw new Error('Automation tag canonical operation did not commit');
    revision = result.node.revision;
  } else {
    if (!operation.text || !operation.annotationId || !operation.creator) throw new Error('Automation note operation is incomplete');
    const wrapped = { ...annotations,canonical: { execute: (input: Parameters<typeof annotations.canonical.execute>[0]) =>
      annotations.canonical.execute({ ...input,automationContext: context }) } };
    const result = await createAnnotation(wrapped,{ actor: { ...actor,creator: operation.creator },command,
      collectionId: operation.collectionId,annotationId: operation.annotationId,operationId: operation.operationId,
      annotation: { type: 'note',subject: { type: 'node',id: operation.nodeId },format: 'plain',value: operation.text,visibility: 'private' } });
    if (result.kind !== 'created') throw new Error('Automation annotation canonical operation did not commit');
    revision = result.annotation.revision;
  }
  return { opId: operation.operationId,sequence: 1,status: 'applied',revision,cursor: operation.operationId,warnings: [] };
}
