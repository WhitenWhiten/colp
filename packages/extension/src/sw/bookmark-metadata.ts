import type { AuthorityContext } from '../authority-fence.js';
import { metadataSyncFetch } from '../metadata-sync-fetch.js';
import type { CompleteRemoteSnapshot } from '../bootstrap/remote-snapshot.js';
import type { SyncScope } from '../sync-state-store.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { reconcileBookmarkTags, importBookmarkTagSnapshot } from '../bookmark-tag-sync.js';
import { reconcileBookmarkNotes } from '../bookmark-note-sync.js';
import { importBookmarkPinSnapshot, reconcileBookmarkPins } from '../bookmark-pin-sync.js';
import { scheduleNativeFoldersFirst } from './bookmark-folders-first.js';
import { createBookmarkNoteClient } from '../bookmark-note-client.js';
import { createNoteProductTransport } from '../note-product-transport.js';
import { scopeKey } from '../sync-state/scope-key.js';
import { metadataSyncInputs } from './metadata-scope.js';
import { createFolderDescriptionStore } from '../folder-description-store.js';
import { reconcileFolderDescriptions, importFolderDescriptionSnapshot } from '../folder-description-sync.js';
import { metadataQueueReader } from '../metadata-queue-state.js';

const notify = () => chrome.runtime.sendMessage({ kind: 'known.bookmarkAnnotations.updated' }).catch(() => undefined);

export async function syncBrowserMetadata(scope: SyncScope, context: AuthorityContext, readNotes = true) {
  const input = await metadataSyncInputs(scope, context);
  if (!input) return { staged: 0, needsSnapshot: false };
  const annotations = createBookmarkAnnotationStore(), descriptionStore = createFolderDescriptionStore();
  try {
    const sync = metadataQueueReader(input.sync);
    const descriptions = await reconcileFolderDescriptions({ ...input, sync, descriptions: descriptionStore });
    const tags = await reconcileBookmarkTags({ ...input, sync, annotations });
    const pins = await reconcileBookmarkPins({ ...input, sync, annotations });
    // A pin learned from another device is placed by the order pass, once sync is idle.
    for (const parentId of pins.changedParents) scheduleNativeFoldersFirst(parentId);
    let notes = false;
    if (readNotes) {
      // Notes cannot hold the native sync lane through an unbounded series of Product requests.
      const options = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId,
        fetch: metadataSyncFetch(scope),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]), assertCurrent: input.assertCurrent };
      const transport = createNoteProductTransport(options);
      const collectionClient = createBookmarkNoteClient({ ...options, scopeKey: scopeKey(scope), transport });
      notes = await reconcileBookmarkNotes({ ...input, annotations, readCollection: nodeIds => collectionClient.readCollection(nodeIds), clientFor: mapping => createBookmarkNoteClient({
        ...options, scopeKey: scopeKey(scope), nodeId: mapping.colpId, transport, assertCurrent: () => input.assertMapping(mapping),
      }) });
    }
    if (descriptions.changed.length || tags.changed.length || pins.changedParents.length || notes) void notify();
    return { staged: descriptions.staged + tags.staged + pins.staged, needsSnapshot: descriptions.needsSnapshot || tags.needsSnapshot };
  } finally { annotations.close(); descriptionStore.close(); }
}

export async function importBrowserMetadata(scope: SyncScope, context: AuthorityContext, snapshot: CompleteRemoteSnapshot) {
  const input = await metadataSyncInputs(scope, context);
  if (!input) return;
  const annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
  try {
    await importFolderDescriptionSnapshot({ ...input, descriptions, snapshot });
    await importBookmarkTagSnapshot({ ...input, annotations }, snapshot);
    const pins = await importBookmarkPinSnapshot({ ...input, annotations }, snapshot); void notify();
    for (const parentId of pins.changedParents) scheduleNativeFoldersFirst(parentId);
  } finally { annotations.close(); descriptions.close(); }
}
