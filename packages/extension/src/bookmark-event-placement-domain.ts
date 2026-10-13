import type { BookmarkEventRecord } from './sync-state-store.js';

function recordFields(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/**
 * N-3 placement domain: target parent, source parent, sibling anchor, same-parent
 * reorder. The node's own id is an anchor so a later placement cannot pass the
 * event that affects it. Content edits are not members, and targetId alone is not a key.
 */
export function placementDomainKeys(event: BookmarkEventRecord): readonly string[] {
  const draft = recordFields(event.details.draft);
  const type = typeof draft.type === 'string' ? draft.type : '';
  if (type !== 'create_node' && type !== 'move_node' && type !== 'delete_node' && type !== 'delete_subtree'
    && event.kind !== 'create' && event.kind !== 'move' && event.kind !== 'remove') return [];
  const context = recordFields(event.details.context);
  const payload = recordFields(draft.payload);
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) keys.add(`${prefix}:${value}`);
  };
  for (const id of [context.parentNativeId, context.targetParentNativeId, context.sourceParentNativeId]) add('parent', id);
  for (const id of [context.afterNativeId, context.beforeNativeId, payload.afterId, payload.beforeId,
    event.nativeId]) add('anchor', id);
  if (context.sourceParentNativeId === context.targetParentNativeId) add('reorder', context.sourceParentNativeId);
  return [...keys];
}
