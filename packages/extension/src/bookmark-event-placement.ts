import { bookmarkRepresentability, captureStep, type BookmarkEventNode } from './bookmark-event-codec.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Capture native anchors once; queue preparation resolves their confirmed identities. */
export function createBookmarkPlacement(input: {
  store: Pick<ReturnType<typeof createSyncStateStore>, 'hasMappingSibling'>; scope: SyncScope;
  listPendingEvents(): Promise<readonly BookmarkEventRecord[]>;
  identityFor(nativeId: string, events: readonly BookmarkEventRecord[]): Promise<EventIdentity | null>;
  readChildren(parentNativeId: string): Promise<readonly BookmarkEventNode[]>;
  canAnchor(node: BookmarkEventNode, parentNativeId: string, allowUnmapped: boolean): Promise<boolean>;
}) {
  const { store, scope, listPendingEvents, identityFor, readChildren, canAnchor } = input;
  return async function placement(parentNativeId: string, nativeId: string, index: number,
    mode: 'mapped' | 'create-history' | 'unmapped' = 'mapped'): Promise<{
    readonly wire: JsonObject; readonly afterNativeId?: string; readonly beforeNativeId?: string
  }> {
    const preferCreateEventHistory = mode === 'create-history';
    const unmapped = mode === 'unmapped';
    const events = await listPendingEvents();
    const pendingSibling = events.some(event => {
      const mapping = event.details.mapping as unknown as MappingInput | undefined;
      return mapping && mapping.nativeId !== nativeId && mapping.parentNativeId === parentNativeId;
    });
    if (!unmapped && !pendingSibling && !await store.hasMappingSibling(scope, parentNativeId, nativeId)) return { wire: {} };
    if (preferCreateEventHistory) {
      const historical = events.flatMap((event) => {
        const context = event.details.context; const mapping = event.details.mapping as unknown as MappingInput | undefined;
        if (!context || typeof context !== 'object' || Array.isArray(context) || !mapping
          || mapping.nativeId === nativeId || mapping.parentNativeId !== parentNativeId
          || typeof context.index !== 'number' || !Number.isSafeInteger(context.index)) return [];
        return [{ nativeId: mapping.nativeId, index: context.index }];
      });
      const candidates: Array<{ nativeId: string; index: number }> = [];
      for (const candidate of historical) {
        const identity = await identityFor(candidate.nativeId, events);
        if (identity && (identity.colpId.startsWith('pending-') || identity.revision.startsWith('local-'))) {
          candidates.push(candidate);
        }
      }
      const before = candidates.filter((candidate) => candidate.index < index)
        .sort((left, right) => right.index - left.index)[0];
      if (before) { const identity = await identityFor(before.nativeId, events); if (identity) {
        return { wire: { afterId: identity.colpId }, afterNativeId: identity.nativeId }; } }
      const after = candidates.filter((candidate) => candidate.index >= index)
        .sort((left, right) => left.index - right.index)[0];
      if (after) { const identity = await identityFor(after.nativeId, events); if (identity) {
        return { wire: { beforeId: identity.colpId }, beforeNativeId: identity.nativeId }; } }
    }
    let siblings: readonly BookmarkEventNode[];
    try { siblings = await captureStep('children_lookup_failed', () => readChildren(parentNativeId)); }
    catch (error) { if (preferCreateEventHistory) return { wire: {} }; throw error; }
    const actual = siblings.findIndex((node) => node.id === nativeId);
    const pivot = actual >= 0 ? actual : Math.max(0, Math.min(index, siblings.length));
    for (let cursor = pivot - 1; cursor >= 0; cursor -= 1) {
      const node = siblings[cursor]!;
      if (!await canAnchor(node, parentNativeId, unmapped) || unmapped && bookmarkRepresentability(node) !== 'supported') continue;
      const sibling = await captureStep('sibling_identity_failed', () => identityFor(node.id, events));
      if (sibling) return { wire: { afterId: sibling.colpId },
        afterNativeId: sibling.nativeId };
      if (unmapped) return { wire: {}, afterNativeId: node.id };
    }
    for (let cursor = pivot + (actual >= 0 ? 1 : 0); cursor < siblings.length; cursor += 1) {
      const node = siblings[cursor]!;
      if (!await canAnchor(node, parentNativeId, unmapped) || unmapped && bookmarkRepresentability(node) !== 'supported') continue;
      const sibling = await captureStep('sibling_identity_failed', () => identityFor(node.id, events));
      if (sibling) return { wire: { beforeId: sibling.colpId },
        beforeNativeId: sibling.nativeId };
      if (unmapped) return { wire: {}, beforeNativeId: node.id };
    }
    return { wire: {} };
  };
}
