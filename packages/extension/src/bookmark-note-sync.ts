import { annotationMatchesBookmark, annotationNoteField, sameAnnotationPresentation, type BookmarkAnnotationStore } from './bookmark-annotation-store.js';
import { annotatedBookmarksFromTree } from './bookmark-annotation-native.js';
import { authoritativeMetadataMapping, metadataBookmarkMatches } from './metadata-queue-state.js';
import { sameMetadataAuthority } from './local-metadata-state.js';
import { createBookmarkNoteClient, NoteSyncError } from './bookmark-note-client.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { BookmarkTagSyncInput } from './bookmark-tag-sync.js';

/** Notes share the local lifecycle; their resource is an Annotation with its own ETag. */
export async function reconcileBookmarkNotes(input: Pick<BookmarkTagSyncInput,
  'scope' | 'sync' | 'tree' | 'allowed' | 'assertCurrent'> & {
    readonly annotations: BookmarkAnnotationStore;
    readonly clientFor: (mapping: import('./sync-state-store.js').MappingInput) => Pick<ReturnType<typeof createBookmarkNoteClient>, 'read' | 'send'>;
    readonly limit?: number;
    readonly readCollection?: (nodeIds: readonly string[]) => Promise<ReadonlyMap<string, import('./bookmark-annotation-sync-types.js').NoteBinding> | null>;
    readonly assertSnapshot?: (mappings: readonly import('./sync-state-store.js').MappingInput[]) => Promise<void>;
  }) {
  const bookmarks = new Map(annotatedBookmarksFromTree(input.tree).map(node => [node.id, node]));
  const records = new Map((await input.annotations.list()).filter(row => {
    const bookmark = bookmarks.get(row.nativeId); return bookmark && annotationMatchesBookmark(row, bookmark);
  }).map(row => [row.nativeId, row]));
  const key = scopeKey(input.scope);
  const mappings = (await input.sync.listMappings(input.scope)).filter(mapping => bookmarks.has(mapping.nativeId)
    && metadataBookmarkMatches(mapping, bookmarks.get(mapping.nativeId)!)
    && authoritativeMetadataMapping(mapping) && input.allowed(mapping)).filter(mapping => {
    const row = records.get(mapping.nativeId), field = row ? annotationNoteField(row) : undefined;
    return (!field?.remote || sameMetadataAuthority(field.remote.scopeKey, key))
      && (!row?.noteIntent || sameMetadataAuthority(row.noteIntent.scopeKey, key) && row.noteIntent.nodeId === mapping.colpId);
  });
  // Prioritize pending writes, then rotate through clean bookmarks by last check; bound each wake's network work.
  const priority = (id: string) => {
    const row = records.get(id);
    const field = row ? annotationNoteField(row) : undefined;
    return row?.noteIntent || field?.state === 'dirty' && field.remote?.supported !== false
      && (row?.noteConflictVersion === undefined || row.noteConflictVersion < field.version) ? 0 : 1;
  };
  mappings.sort((a, b) => priority(a.nativeId) - priority(b.nativeId)
    || (records.get(a.nativeId)?.noteCheckedAt ?? 0) - (records.get(b.nativeId)?.noteCheckedAt ?? 0));
  let changed = false;
  const snapshot = input.readCollection ? await input.readCollection(mappings.map(mapping => mapping.colpId)) : undefined;
  if (snapshot) {
    await input.assertCurrent();
    await input.assertSnapshot?.(mappings);
    await input.annotations.observeNotesMany(mappings.map(mapping => ({ bookmark: bookmarks.get(mapping.nativeId)!,
      binding: snapshot.get(mapping.colpId) ?? { scopeKey: key, resourceId: mapping.colpId, revision: 'absent', annotationId: null, value: null, supported: true } })));
    const after = await input.annotations.getMany([...bookmarks.values()]);
    changed = mappings.some(mapping => !sameAnnotationPresentation(records.get(mapping.nativeId) ?? null, after.get(mapping.nativeId) ?? null));
  }
  const selected = input.readCollection ? mappings.filter(mapping => priority(mapping.nativeId) === 0) : mappings.slice(0, input.limit ?? 20);
  for (const mapping of selected) {
    const bookmark = bookmarks.get(mapping.nativeId)!;
    const before = await input.annotations.get(bookmark), priorField = before ? annotationNoteField(before) : undefined;
    if (priorField?.remote && !sameMetadataAuthority(priorField.remote.scopeKey, key)) continue;
    let intent = before?.noteIntent;
    if (intent && (!sameMetadataAuthority(intent.scopeKey, key) || intent.nodeId !== mapping.colpId)) continue;
    try {
      const client = input.clientFor(mapping);
      await input.assertCurrent();
      // Replay an unknown outcome before reading: an unobserved create must not become a second create.
      if (!intent) {
        const binding = snapshot?.get(mapping.colpId) ?? (snapshot ? { scopeKey: key, resourceId: mapping.colpId, revision: 'absent', annotationId: null, value: null, supported: true } : await client.read(mapping.colpId));
        await input.assertCurrent();
        await input.annotations.observeNote(bookmark, binding);
        const prepared = await input.annotations.prepareNote(bookmark, key, mapping.colpId);
        intent = prepared?.noteIntent;
      }
      if (intent) {
        const binding = await client.send(intent);
        await input.assertCurrent();
        await input.annotations.finishNote(bookmark, intent, { kind: 'applied', binding });
      }
      changed = changed || !sameAnnotationPresentation(before, await input.annotations.get(bookmark));
    } catch (error) {
      if (intent && error instanceof NoteSyncError && !error.sameRequestRetrySafe
        && [400, 403, 404, 409, 410, 412, 413, 415, 422].includes(error.status)) {
        await input.assertCurrent();
        await input.annotations.finishNote(bookmark, intent, { kind: 'review' });
        changed = true;
      }
      // Session/network failures leave the exact intent durable and stop this wake's scan.
      else if (!(error instanceof NoteSyncError) || error.sameRequestRetrySafe || error.status === 401 || error.status === 429 || error.status >= 500) break;
    } finally { await input.annotations.markNoteChecked(bookmark); }
  }
  if (snapshot && 'snapshotRevision' in snapshot && typeof snapshot.snapshotRevision === 'string') {
    await input.assertCurrent();
    await chrome.storage.local.set({ 'known.annotations.snapshot-revision.v1': { scopeKey: 'snapshotScopeKey' in snapshot && typeof snapshot.snapshotScopeKey === 'string' ? snapshot.snapshotScopeKey : key, revision: snapshot.snapshotRevision } });
  }
  return changed;
}
