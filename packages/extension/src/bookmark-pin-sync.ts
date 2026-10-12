import { annotationPinField, type createBookmarkAnnotationStore } from './bookmark-annotation-store.js';
import { annotatedBookmarksFromTree } from './bookmark-annotation-native.js';
import type { PinBinding } from './bookmark-annotation-sync-types.js';
import { extensionsPinned } from './bookmark-pin-order.js';
import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import type { createBookmarkEventQueue } from './bookmark-event-queue.js';
import { sameMetadataAuthority } from './local-metadata-state.js';
import { authoritativeMetadataMapping, metadataBookmarkMatches, settledMetadataAttempt, type MetadataQueueStore } from './metadata-queue-state.js';
import type { FolderTreeNode } from './save-folder.js';
import { canonicalJson } from './sync-state/codec.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { JsonObject, MappingInput, SyncScope } from './sync-state-store.js';

export interface BookmarkPinSyncInput {
  readonly scope: SyncScope; readonly sync: MetadataQueueStore;
  readonly annotations: ReturnType<typeof createBookmarkAnnotationStore>;
  readonly tree: readonly FolderTreeNode[];
  readonly queue: Pick<ReturnType<typeof createBookmarkEventQueue>, 'pinned'>;
  readonly allowed: (mapping: MappingInput) => boolean;
  readonly assertCurrent: () => Promise<void>;
}

const extensionsOf = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

function binding(key: string, resourceId: string, revision: string, extensions: JsonObject): PinBinding {
  return { scopeKey: key, resourceId, revision, value: extensionsPinned(extensions), extensions: canonicalJson(extensions) };
}

/**
 * Same lifecycle as tags: observe the last landed projection, then upload a
 * dirty pin as an update of the bookmark's extension map. Returns the parents
 * whose pinned set changed, so the order pass can place them.
 */
export async function reconcileBookmarkPins(input: BookmarkPinSyncInput) {
  const bookmarks = new Map(annotatedBookmarksFromTree(input.tree).map(node => [node.id, node]));
  const mappings = (await input.sync.listMappings(input.scope)).filter(mapping => bookmarks.has(mapping.nativeId)
    && metadataBookmarkMatches(mapping, bookmarks.get(mapping.nativeId)!) && authoritativeMetadataMapping(mapping) && input.allowed(mapping));
  const key = scopeKey(input.scope);
  const before = await input.annotations.getMany([...bookmarks.values()]);
  const observations: Parameters<typeof input.annotations.observePinsMany>[0][number][] = [];
  for (const mapping of mappings) {
    const bookmark = bookmarks.get(mapping.nativeId)!, prior = before.get(bookmark.id);
    const field = prior ? annotationPinField(prior) : undefined;
    if (field?.remote && !sameMetadataAuthority(field.remote.scopeKey, key)) continue;
    const extensions = extensionsOf(mapping.projection.content?.extensions);
    // Nothing to learn from an unpinned node this browser never pinned.
    if (!field && !extensionsPinned(extensions)) continue;
    observations.push({ bookmark, binding: binding(key, mapping.colpId, mapping.projection.revision, extensions),
      settledVersion: await settledMetadataAttempt(input.sync, input.scope, field?.attempt, mapping.projection.revision) });
  }
  await input.assertCurrent(); await input.annotations.observePinsMany(observations);
  const records = await input.annotations.getMany([...bookmarks.values()]);
  const changedParents = new Set<string>();
  let staged = 0;
  for (const mapping of mappings) {
    const bookmark = bookmarks.get(mapping.nativeId)!, record = records.get(bookmark.id);
    if (Boolean(before.get(bookmark.id)?.pinned) !== Boolean(record?.pinned) && bookmark.parentId) changedParents.add(bookmark.parentId);
    const field = record ? annotationPinField(record) : undefined;
    if (!field?.remote || field.state !== 'dirty' || field.remote.resourceId !== mapping.colpId
      || !sameMetadataAuthority(field.remote.scopeKey, key)) continue;
    await input.assertCurrent();
    const attempted = await input.annotations.markPinAttempt(bookmark, field), attempt = attempted?.pinSync?.attempt;
    if (!attempt) continue;
    await input.assertCurrent();
    const result = await input.queue.pinned(bookmark.id, attempt.value,
      { revision: field.remote.revision, extensions: JSON.parse(field.remote.extensions) as JsonObject, eventId: attempt.eventId });
    if (result.eventId && result.eventId !== attempt.eventId) await input.annotations.markPinAttempt(bookmark, field, result.eventId);
    if (result.outcome === 'staged' || result.outcome === 'duplicate') staged++;
  }
  return { staged, changedParents: [...changedParents] };
}

/**
 * First sync: a pin on either side wins, the same as other bookmark metadata.
 * Returns the parents whose pinned set changed, so the order pass can place them:
 * the other device may have kept its pins paused, leaving Position unsorted.
 */
export async function importBookmarkPinSnapshot(input: BookmarkPinSyncInput, snapshot: CompleteRemoteSnapshot) {
  const facts = new Map(snapshot.remoteFacts.map(fact => [fact.nodeId, fact]));
  const bookmarks = new Map(annotatedBookmarksFromTree(input.tree).map(node => [node.id, node]));
  const observations: Parameters<typeof input.annotations.observePinsMany>[0][number][] = [];
  for (const mapping of await input.sync.listMappings(input.scope)) {
    const bookmark = bookmarks.get(mapping.nativeId), fact = facts.get(mapping.colpId);
    if (!bookmark || fact?.kind !== 'bookmark' || fact.url !== bookmark.url || !fact.extensions
      || !authoritativeMetadataMapping(mapping) || !input.allowed(mapping)) continue;
    observations.push({ bookmark, binding: binding(scopeKey(input.scope), mapping.colpId, fact.revision, extensionsOf(fact.extensions)) });
  }
  const observed = observations.map(observation => bookmarks.get(observation.bookmark.id)!);
  const before = await input.annotations.getMany(observed);
  await input.assertCurrent(); await input.annotations.observePinsMany(observations);
  const after = await input.annotations.getMany(observed);
  return { changedParents: [...new Set(observed.flatMap(bookmark => bookmark.parentId
    && Boolean(before.get(bookmark.id)?.pinned) !== Boolean(after.get(bookmark.id)?.pinned) ? [bookmark.parentId] : []))] };
}
