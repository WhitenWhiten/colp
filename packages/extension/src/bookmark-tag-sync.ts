import { annotationTagField, createBookmarkAnnotationStore, sameAnnotationPresentation } from './bookmark-annotation-store.js';
import { annotatedBookmarksFromTree } from './bookmark-annotation-native.js';
import { authoritativeMetadataMapping, metadataBookmarkMatches, settledMetadataAttempt, type MetadataQueueStore } from './metadata-queue-state.js';
import { sameMetadataAuthority } from './local-metadata-state.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { FolderTreeNode } from './save-folder.js';
import type { MappingInput, SyncScope } from './sync-state-store.js';
import type { createBookmarkEventQueue } from './bookmark-event-queue.js';
import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import { tagsFitSync } from './bookmark-tag-limits.js';

export interface BookmarkTagSyncInput {
  readonly scope: SyncScope; readonly sync: MetadataQueueStore;
  readonly annotations: ReturnType<typeof createBookmarkAnnotationStore>;
  readonly tree: readonly FolderTreeNode[];
  readonly queue: Pick<ReturnType<typeof createBookmarkEventQueue>, 'tagged'>;
  readonly allowed: (mapping: MappingInput) => boolean;
  readonly assertCurrent: () => Promise<void>;
}

export async function reconcileBookmarkTags(input: BookmarkTagSyncInput) {
  const bookmarks = new Map(annotatedBookmarksFromTree(input.tree).map(node => [node.id, node]));
  const mappings = (await input.sync.listMappings(input.scope)).filter(mapping => bookmarks.has(mapping.nativeId)
    && metadataBookmarkMatches(mapping, bookmarks.get(mapping.nativeId)!) && authoritativeMetadataMapping(mapping) && input.allowed(mapping));
  const key = scopeKey(input.scope);
  let needsSnapshot = false, staged = 0;
  const changed: string[] = [];
  const before = await input.annotations.getMany([...bookmarks.values()]);
  const observations: Parameters<typeof input.annotations.observeTagsMany>[0][number][] = [];
  for (const mapping of mappings) {
    const bookmark = bookmarks.get(mapping.nativeId)!, prior = before.get(bookmark.id);
    if (prior?.tagsSync?.remote && !sameMetadataAuthority(prior.tagsSync.remote.scopeKey, key)) continue;
    const tags = mapping.projection.content?.tags;
    if (Array.isArray(tags) && tags.every(tag => typeof tag === 'string')) observations.push({ bookmark,
      binding: { scopeKey: key, resourceId: mapping.colpId, revision: mapping.projection.revision, value: tags as string[] },
      settledVersion: await settledMetadataAttempt(input.sync, input.scope, prior?.tagsSync?.attempt, mapping.projection.revision) });
  }
  await input.assertCurrent(); await input.annotations.observeTagsMany(observations);
  const records = await input.annotations.getMany([...bookmarks.values()]);
  for (const mapping of mappings) {
    const bookmark = bookmarks.get(mapping.nativeId)!, record = records.get(bookmark.id), field = record ? annotationTagField(record) : undefined;
    if (!sameAnnotationPresentation(before.get(bookmark.id) ?? null, record ?? null)) changed.push(bookmark.id);
    if (!field?.remote) { needsSnapshot = true; continue; }
    if (field.state !== 'dirty' || field.remote.resourceId !== mapping.colpId
      || !sameMetadataAuthority(field.remote.scopeKey, key)) continue;
    // Keep every local member for explicit review; one incompatible bookmark must not stop the entire cycle.
    if (!tagsFitSync(field.value)) continue;
    await input.assertCurrent();
    const attempted = await input.annotations.markTagsAttempt(bookmark, field), attempt = attempted?.tagsSync?.attempt;
    if (!attempt) continue;
    await input.assertCurrent();
    const result = await input.queue.tagged(bookmark.id, attempt.value,
      { revision: field.remote.revision, tags: field.remote.value, eventId: attempt.eventId });
    if (result.eventId && result.eventId !== attempt.eventId) await input.annotations.markTagsAttempt(bookmark, field, result.eventId);
    if (result.outcome === 'staged' || result.outcome === 'duplicate') staged++;
  }
  return { staged, needsSnapshot, changed };
}

export async function importBookmarkTagSnapshot(input: BookmarkTagSyncInput, snapshot: CompleteRemoteSnapshot) {
  const facts = new Map(snapshot.remoteFacts.map(fact => [fact.nodeId, fact]));
  const bookmarks = new Map(annotatedBookmarksFromTree(input.tree).map(node => [node.id, node]));
  for (const mapping of await input.sync.listMappings(input.scope)) {
    const bookmark = bookmarks.get(mapping.nativeId), fact = facts.get(mapping.colpId);
    if (!bookmark || fact?.kind !== 'bookmark' || fact.url !== bookmark.url
      || (mapping.nodeKind !== 'bookmark' && mapping.nodeKind !== undefined)
      || !authoritativeMetadataMapping(mapping) || !input.allowed(mapping)) continue;
    await input.assertCurrent();
    await input.annotations.observeTags(bookmark, { scopeKey: scopeKey(input.scope), resourceId: mapping.colpId,
      revision: fact.revision, value: fact.tags ?? [] });
  }
}
