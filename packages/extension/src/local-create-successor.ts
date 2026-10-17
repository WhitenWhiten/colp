import type { BookmarkEventRecord, JsonObject } from './sync-state-store.js';

export function createSuccessorTarget(target: unknown, colpId: string, createOpId?: string): boolean {
  return target === colpId || createOpId !== undefined && target === `pending-${createOpId}`;
}

/** A captured removal names native identities, including the members of a removed folder. */
export function localRemovalCoversNative(event: BookmarkEventRecord, nativeId: string,
  colpId: string, createOpId?: string): boolean {
  const draft = event.details.draft as JsonObject | undefined;
  if (event.kind !== 'remove' || !draft || !Array.isArray(event.details.deleteNativeIds)
      || !event.details.deleteNativeIds.includes(nativeId)) return false;
  if (event.nativeId !== nativeId) return draft.type === 'delete_subtree';
  return (draft.type === 'delete_node' || draft.type === 'delete_subtree')
    && createSuccessorTarget(draft.targetId, colpId, createOpId);
}
