import { createFolderDescriptionStore, descriptionMatchesFolder, type FolderDescriptionRecord,
  type FolderDescriptionObservation } from './folder-description-store.js';
import { descriptionFoldersFromTree } from './folder-description-native.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { FolderTreeNode } from './save-folder.js';
import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { createBookmarkEventQueue } from './bookmark-event-queue.js';
import { authoritativeMetadataMapping as authoritative, settledMetadataAttempt, type MetadataQueueStore } from './metadata-queue-state.js';
import { sameMetadataAuthority } from './local-metadata-state.js';

type Store = ReturnType<typeof createFolderDescriptionStore>;
type Sync = MetadataQueueStore;

async function resolvedAttemptVersion(sync: Sync, scope: SyncScope, record: FolderDescriptionRecord | undefined) {
  const attempt = record?.attempt;
  if (record?.state !== 'dirty' || !attempt?.eventId || !sameMetadataAuthority(attempt.scopeKey, scopeKey(scope))) return undefined;
  return settledMetadataAttempt(sync, scope, { ...attempt, resourceId: attempt.colpId,
    value: attempt.description, revision: record.remote?.revision ?? '', eventId: attempt.eventId });
}

/** No networking: a local edit stays dirty until an authoritative projection confirms it. */
export async function reconcileFolderDescriptions(input: {
  readonly scope: SyncScope; readonly sync: Sync;
  readonly descriptions: Store; readonly tree: readonly FolderTreeNode[];
  readonly queue: Pick<ReturnType<typeof createBookmarkEventQueue>, 'described'>;
  readonly assertCurrent: () => Promise<void>;
  readonly allowed: (mapping: MappingInput) => boolean;
}) {
  const folders = descriptionFoldersFromTree(input.tree), mappings = await input.sync.listMappings(input.scope);
  const key = scopeKey(input.scope), observations: FolderDescriptionObservation[] = [];
  const recordsBefore = new Map((await input.descriptions.list()).map(record => [record.nativeId, record]));
  await input.assertCurrent();
  for (const mapping of mappings) {
    const folder = folders.get(mapping.nativeId), content = mapping.projection.content;
    if (!folder || !input.allowed(mapping) || mapping.nodeKind !== 'folder' || !authoritative(mapping) || !content || !Object.hasOwn(content, 'description')) continue;
    const description = typeof content.description === 'string' ? content.description : null;
    const record = recordsBefore.get(folder.id);
    const resolved = record && descriptionMatchesFolder(record, folder) && record.attempt?.colpId === mapping.colpId
      ? await resolvedAttemptVersion(input.sync, input.scope, record) : undefined;
    observations.push({ folder, binding: { scopeKey: key, colpId: mapping.colpId, revision: mapping.projection.revision, description },
      ...(resolved === undefined ? {} : { resolvedAttemptVersion: resolved }) });
  }
  await input.assertCurrent();
  const changed = await input.descriptions.observeRemote(observations);
  const byNative = new Map(mappings.filter(mapping => authoritative(mapping) && input.allowed(mapping)).map(mapping => [mapping.nativeId, mapping]));
  let staged = 0, needsSnapshot = false;
  for (const record of await input.descriptions.list()) {
    const folder = folders.get(record.nativeId), mapping = byNative.get(record.nativeId);
    if (!folder || !descriptionMatchesFolder(record, folder) || mapping?.nodeKind !== 'folder') continue;
    if (record.state !== 'dirty') continue;
    if (record.reviewVersion !== undefined && record.reviewVersion >= record.version) continue;
    if (record.remote && !sameMetadataAuthority(record.remote.scopeKey, key)) continue;
    const baseline = record.remote?.scopeKey === key && record.remote.colpId === mapping.colpId ? record.remote : undefined;
    if (!baseline) { needsSnapshot = true; continue; }
    await input.assertCurrent();
    // Persist the explicit value before staging; a restart can recognize its echo even after a newer local edit.
    const attempt = await input.descriptions.markAttempt(folder, record, baseline);
    if (!attempt) continue;
    await input.assertCurrent();
    const result = await input.queue.described(record.nativeId, record.description, { ...baseline, eventId: attempt.eventId });
    if (result.eventId && result.eventId !== attempt.eventId) await input.descriptions.markAttempt(folder, record, baseline, result.eventId);
    if (result.outcome === 'staged' || result.outcome === 'duplicate') staged++;
  }
  // Older clients persisted only native title/URL. Read the complete snapshot once to migrate missing metadata.
  const records = new Map((await input.descriptions.list()).map(record => [record.nativeId, record]));
  for (const mapping of byNative.values()) if (mapping.nodeKind === 'folder' && folders.has(mapping.nativeId)
      && !Object.hasOwn(mapping.projection.content ?? {}, 'description')) {
    const binding = records.get(mapping.nativeId)?.remote;
    if (binding && !sameMetadataAuthority(binding.scopeKey, key)) continue;
    if (binding?.scopeKey !== key || binding.colpId !== mapping.colpId) needsSnapshot = true;
  }
  return { staged, needsSnapshot, changed };
}

export async function importFolderDescriptionSnapshot(input: {
  readonly scope: SyncScope; readonly sync: Pick<ReturnType<typeof createSyncStateStore>, 'listMappings'>;
  readonly descriptions: Store; readonly tree: readonly FolderTreeNode[]; readonly snapshot: CompleteRemoteSnapshot;
  readonly assertCurrent: () => Promise<void>;
  readonly allowed: (mapping: MappingInput) => boolean;
}) {
  const folders = descriptionFoldersFromTree(input.tree), mappings = await input.sync.listMappings(input.scope);
  const facts = new Map(input.snapshot.remoteFacts.map(fact => [fact.nodeId, fact]));
  const observations: FolderDescriptionObservation[] = [];
  for (const mapping of mappings) {
    const folder = folders.get(mapping.nativeId), fact = facts.get(mapping.colpId);
    if (!folder || !input.allowed(mapping) || mapping.nodeKind !== 'folder' || !authoritative(mapping) || fact?.kind !== 'folder') continue;
    observations.push({ folder, binding: { scopeKey: scopeKey(input.scope), colpId: fact.nodeId,
      revision: fact.revision, description: fact.description ?? null } });
  }
  await input.assertCurrent();
  return input.descriptions.observeRemote(observations);
}
