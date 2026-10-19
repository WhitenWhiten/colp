import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { annotationNoteField, createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { reconcileBookmarkTags } from '../src/bookmark-tag-sync.js';
import { reconcileBookmarkNotes } from '../src/bookmark-note-sync.js';
import { NoteSyncError } from '../src/bookmark-note-client.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import type { NoteBinding, NoteIntent } from '../src/bookmark-annotation-sync-types.js';
import { settledMetadataAttempt } from '../src/metadata-queue-state.js';

const bookmark = { id: 'mapped', title: 'Page', parentId: 'root-selected', dateAdded: 7, url: 'https://example.test/' };
let factory: IDBFactory, f: Awaited<ReturnType<typeof fixture>>, annotations: ReturnType<typeof createBookmarkAnnotationStore>;
const binding = (value: string | null, revision = 'note-r1', annotationId: string | null = 'note-a'): NoteBinding => ({
  scopeKey: scopeKey(scope), resourceId: 'mapped-colp', value, revision, annotationId, supported: true,
});
const input = () => ({ scope, sync: f.store, annotations, tree: [bookmark], queue: f.queue,
  allowed: () => true, assertCurrent: async () => undefined });
beforeEach(async () => {
  factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  f = await fixture(factory, { mappedNode: true }); annotations = createBookmarkAnnotationStore({ indexedDB: factory });
  f.api.put(bookmark);
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'bookmark', projection: { ...mapping.projection,
    content: { title: bookmark.title, url: bookmark.url, tags: ['base'] } } });
});
afterEach(() => { annotations.close(); f.store.close(); vi.unstubAllGlobals(); });

test('tags use the durable node queue with a trusted field-only baseline, and do not change the note', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['base', 'local'], note: 'Private draft' });
  expect(await reconcileBookmarkTags(input())).toMatchObject({ staged: 1 });
  await f.queue.flush();
  expect((await f.store.listQueue(scope))[0]?.payload).toMatchObject({ type: 'update_node_content',
    targetId: 'mapped-colp', baseRevision: 'server-revision-7',
    payload: { base: { tags: ['base'] }, value: { tags: ['base', 'local'] } } });
  expect((await annotations.get(bookmark))?.note).toBe('Private draft');
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('dirty');
});

test('a clear is retained until its echo, and an old cloud value cannot resurrect it', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: [], note: null });
  await reconcileBookmarkTags(input()); await f.queue.flush();
  const row = (await annotations.get(bookmark))!;
  expect(row.tagsSync?.state).toBe('dirty'); expect(row.tags).toEqual([]);
  expect((await f.store.listQueue(scope))[0]?.payload).toMatchObject({ payload: { value: { tags: [] } } });
  await annotations.observeTags(bookmark, { ...row.tagsSync!.remote!, revision: 'r2', value: [] });
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('synced');
});

test('newer drafts survive a merged authoritative receipt, and tag/note versions are independent', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['base', 'local'], note: null });
  await reconcileBookmarkTags(input());
  const sent = (await annotations.get(bookmark))!.tagsSync!;
  await annotations.save(bookmark, { tags: ['base', 'local', 'newer'], note: 'New note' });
  await annotations.observeTags(bookmark, { ...sent.remote!, revision: 'merged-r2', value: ['base', 'local', 'concurrent'] }, sent.version);
  const row = (await annotations.get(bookmark))!;
  expect(row.tags).toEqual(['base', 'concurrent', 'local', 'newer']); expect(row.tagsSync?.state).toBe('dirty');
  expect(row.tagsSync?.remote?.value).toEqual(['base', 'local', 'concurrent']);
  const version = row.tagsSync?.version;
  await annotations.save(bookmark, { tags: row.tags, note: 'Only note changes' });
  expect((await annotations.get(bookmark))?.tagsSync?.version).toBe(version);
});

test('editing a note preserves every cloud tag, including case distinctions and commas', async () => {
  const tags = ['News', 'news', 'a,b', 'x'.repeat(64)];
  await annotations.observeTags(bookmark, { scopeKey: scopeKey(scope), resourceId: 'mapped-colp', revision: 'r1', value: tags });
  await annotations.save(bookmark, { tags, note: 'Edited' });
  expect((await annotations.get(bookmark))?.tags).toEqual(tags);
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('synced');
});

test('private/detached nodes author no operation, and another account cannot adopt an existing binding', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['private'], note: 'private' });
  expect((await reconcileBookmarkTags({ ...input(), allowed: () => false })).staged).toBe(0);
  await annotations.observeTags(bookmark, { scopeKey: scopeKey({ ...scope, accountId: 'account-b' }),
    resourceId: 'other-node', revision: 'other-r1', value: ['other'] });
  expect((await annotations.get(bookmark))?.tagsSync?.remote?.scopeKey).toBe(scopeKey(scope));
  expect(await f.store.listQueue(scope)).toEqual([]);
});

test('an ambiguous note create replays its exact durable command after restart before reading again', async () => {
  await annotations.save(bookmark, { tags: [], note: 'Draft' });
  const read = vi.fn(async () => binding(null, 'absent', null));
  const send = vi.fn(async (_intent: NoteIntent): Promise<NoteBinding> => { throw new Error('connection lost'); });
  await reconcileBookmarkNotes({ ...input(), clientFor: () => ({ read, send }) });
  const intent = (await annotations.get(bookmark))!.noteIntent!;
  expect(intent.action).toBe('create'); expect(read).toHaveBeenCalledTimes(1);
  annotations.close(); annotations = createBookmarkAnnotationStore({ indexedDB: factory });
  await annotations.save(bookmark, { tags: [], note: 'Newer draft' });
  send.mockImplementation(async seen => { expect(seen).toEqual(intent); return binding('Draft', 'note-r2'); });
  await reconcileBookmarkNotes({ ...input(), clientFor: () => ({ read, send }) });
  expect(read).toHaveBeenCalledTimes(1);
  const row = (await annotations.get(bookmark))!;
  expect(row.noteIntent).toBeUndefined(); expect(row.note).toBe('Newer draft');
  expect(row.noteSync?.state).toBe('dirty'); expect(row.noteSync?.remote?.value).toBe('Draft');
});

test('note deletion is a conditional delete of its bound private annotation', async () => {
  await annotations.observeNote(bookmark, binding('Cloud'));
  await annotations.save(bookmark, { tags: [], note: null });
  const send = vi.fn(async (intent: NoteIntent) => {
    expect(intent).toMatchObject({ action: 'delete', annotationId: 'note-a', revision: 'note-r1', value: null });
    return binding(null, 'absent', null);
  });
  await reconcileBookmarkNotes({ ...input(), clientFor: () => ({ read: async () => binding('Cloud'), send }) });
  expect(send).toHaveBeenCalledTimes(1);
  expect((await annotations.get(bookmark))?.noteSync?.state).toBe('synced');
});

test('a stale note ETag keeps the local draft and blocks silent re-authoring until a new explicit edit', async () => {
  await annotations.observeNote(bookmark, binding('Before'));
  await annotations.save(bookmark, { tags: [], note: 'Local' });
  const send = vi.fn(async (): Promise<NoteBinding> => { throw new NoteSyncError(412, 'precondition_failed'); });
  const client = { read: async () => binding('Concurrent', 'note-r2'), send };
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  expect(send).toHaveBeenCalledTimes(1);
  expect((await annotations.get(bookmark))?.note).toBe('Local');
  await annotations.save(bookmark, { tags: [], note: 'Explicit new draft' });
  send.mockImplementation(async () => binding('Explicit new draft', 'note-r3'));
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  expect(send).toHaveBeenCalledTimes(2);
  expect((await annotations.get(bookmark))?.noteSync?.state).toBe('synced');
});

test('unsupported notes and foreign authority bindings never send a mutation', async () => {
  await annotations.save(bookmark, { tags: [], note: 'Local draft' });
  const send = vi.fn(async () => binding('Local draft'));
  await reconcileBookmarkNotes({ ...input(), clientFor: () => ({ read: async () => ({ ...binding('Markdown'), supported: false }), send }) });
  expect(send).not.toHaveBeenCalled(); expect((await annotations.get(bookmark))?.note).toBe('Local draft');
  const row = (await annotations.get(bookmark))!;
  expect(annotationNoteField(row).state).toBe('dirty');
  const read = vi.fn(async () => binding('Foreign'));
  await reconcileBookmarkNotes({ ...input(), scope: { ...scope, accountId: 'account-b' }, clientFor: () => ({ read, send }) });
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test('a retry-safe in-progress note response retains its exact command instead of creating a replacement', async () => {
  await annotations.save(bookmark, { tags: [], note: 'Draft' });
  const send = vi.fn(async (): Promise<NoteBinding> => { throw new NoteSyncError(409, 'command_in_progress', true); });
  const client = { read: vi.fn(async () => binding(null, 'absent', null)), send };
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  const first = (await annotations.get(bookmark))!.noteIntent!;
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  expect((await annotations.get(bookmark))?.noteIntent).toEqual(first);
  expect(client.read).toHaveBeenCalledTimes(1);
});

test('a merged tag receipt is acknowledged after its Pull echo even if a later cloud edit already advanced the projection', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['base', 'local'], note: null });
  await reconcileBookmarkTags(input()); await f.queue.flush();
  const queued = (await f.store.listQueue(scope))[0]!;
  const lease = await f.store.acquireLease(scope, 'metadata-test', 100, 1000);
  await f.store.claimQueue(scope, 'metadata-test', lease.fence, 100, queued.sequence);
  await f.store.settleClaimedPush(scope, queued.sequence, 'metadata-test', lease.fence, { outcome: 'terminal', receipt: {
    kind: 'terminal', opId: queued.opId, operationDigest: queued.digest, receiptId: 'tag-merge', resultDigest: 'sha256:tag-merge',
    result: { results: [{ opId: queued.opId, sequence: queued.sequence, status: 'rebased', revision: 'merged-r2' }] },
  } });
  await f.store.stagePullPage(scope, { pageId: 'tag-echo', previousCursor: 'cursor-3', nextCursor: 'cursor-4',
    collectionRevision: 'collection-r4', pageDigest: 'sha256:tag-echo', effectPages: [], events: [{
      eventId: 'tag-echo', cursor: 'cursor-4', operationId: queued.opId, effectId: 'tag-effect',
      effectDigest: 'sha256:tag-effect', operationDigest: queued.digest, kind: 'node_content_updated',
      initialState: 'authority_committed', payload: { kind: 'operation', operation: { opId: queued.opId } },
    }] });
  await f.store.completePullPage(scope, 'tag-echo');
  expect((await f.store.getQueueByOpId(scope, queued.opId))?.echoApplied).toBe(true);
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'later-r3', resourceRevision: 'later-r3',
    content: { title: bookmark.title, url: bookmark.url, tags: ['base', 'local', 'concurrent', 'later'] } } });
  const attempted = (await annotations.get(bookmark))!.tagsSync!;
  expect(await settledMetadataAttempt(f.store, scope, attempted.attempt, 'later-r3')).toBe(attempted.version);
  expect((await f.store.getMappingByNativeId(scope, bookmark.id))?.nodeKind).toBe('bookmark');
  expect((await reconcileBookmarkTags(input())).staged).toBe(0);
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('synced');
  expect((await annotations.get(bookmark))?.tags).toEqual(['base', 'local', 'concurrent', 'later']);
});

test('re-authentication can acknowledge a settled old-generation tag attempt without resurrecting it', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['base', 'local'], note: null });
  await reconcileBookmarkTags(input()); await f.queue.flush();
  const queued = (await f.store.listQueue(scope))[0]!;
  const lease = await f.store.acquireLease(scope, 'old-generation', 100, 1000);
  await f.store.claimQueue(scope, 'old-generation', lease.fence, 100, queued.sequence);
  await f.store.settleClaimedPush(scope, queued.sequence, 'old-generation', lease.fence, { outcome: 'terminal', receipt: {
    kind: 'terminal', opId: queued.opId, operationDigest: queued.digest, receiptId: 'old-result', resultDigest: 'sha256:old-result',
    result: { results: [{ opId: queued.opId, sequence: queued.sequence, status: 'rebased', revision: 'merged-r2' }] },
  } });
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  const next = { ...scope, generation: 2 };
  await f.store.registerScope({ ...next, lifecycle: 'active', lease: { leaseId: 'new-lease', expiresAt: 10000 },
    checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
  await f.store.putMapping(next, { ...mapping, projection: { ...mapping.projection, revision: 'merged-r2', resourceRevision: 'merged-r2',
    content: { title: bookmark.title, url: bookmark.url, tags: ['base', 'local', 'concurrent'] } } });
  const sibling = { ...scope, collectionId: 'other-collection' };
  await f.store.registerScope({ ...sibling, lifecycle: 'active', lease: { leaseId: 'sibling', expiresAt: 10000 },
    checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
  await f.store.retireScope(sibling, { retiredAt: 100, reason: 'authority_fenced' });
  await f.store.retireScope(scope, { retiredAt: 200, reason: 'authority_fenced' });
  const oldAttempt = (await annotations.get(bookmark))!.tagsSync!;
  expect(await settledMetadataAttempt(f.store, next, oldAttempt.attempt, 'merged-r2')).toBe(oldAttempt.version);
  expect((await reconcileBookmarkTags({ ...input(), scope: next })).staged).toBe(0);
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('synced');
  expect((await annotations.get(bookmark))?.tags).toEqual(['base', 'local', 'concurrent']);
});

test('legacy kind-less bookmark mappings sync, while mismatched native URLs cannot read or overwrite remote metadata', async () => {
  const { scopeKey: _key, nodeKind: _kind, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, mapping);
  await reconcileBookmarkTags(input());
  expect((await annotations.get(bookmark))?.tags).toEqual(['base']);
  const read = vi.fn(async () => binding('Wrong note')), send = vi.fn(async () => binding('Wrong note'));
  const different = { ...input(), tree: [{ ...bookmark, url: 'https://other.test/' }] };
  expect((await reconcileBookmarkTags(different)).staged).toBe(0);
  await reconcileBookmarkNotes({ ...different, clientFor: () => ({ read, send }) });
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test('an open editor changes only its edited fields and cannot erase unseen cloud tags or overwrite a changed note', async () => {
  await reconcileBookmarkTags(input()); await annotations.observeNote(bookmark, binding('Before'));
  const base = { tags: ['base'], note: 'Before' };
  await annotations.observeTags(bookmark, { scopeKey: scopeKey(scope), resourceId: 'mapped-colp', revision: 'r2', value: ['base', 'concurrent'] });
  await annotations.save(bookmark, { tags: base.tags, note: 'User note' }, { base });
  expect((await annotations.get(bookmark))?.tags).toEqual(['base', 'concurrent']);
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('synced');
  await annotations.save(bookmark, { tags: ['local'], note: 'User note' }, { base: { tags: ['base'], note: 'User note' } });
  expect((await annotations.get(bookmark))?.tags).toEqual(['concurrent', 'local']);
  await expect(annotations.save(bookmark, { tags: ['wrong'], note: 'Stale draft' }, { base })).rejects.toThrow();
  expect((await annotations.get(bookmark))?.note).toBe('User note');
  expect((await annotations.get(bookmark))?.tags).toEqual(['concurrent', 'local']);
});

test('editing AI result chips before Pull preserves selected tags and a removal remains dirty until canonical confirmation', async () => {
  await annotations.save(bookmark, { tags: [], note: 'Local' });
  const base = { tags: ['ai'], sourceTags: [], note: 'Local' };
  await annotations.save(bookmark, { tags: ['ai', 'manual'], note: 'Local' }, { base });
  expect((await annotations.get(bookmark))?.tags).toEqual(['ai', 'manual']);
  await annotations.save({ ...bookmark, id: 'not-yet-pulled' }, { tags: [], note: 'Local' });
  const ref = { ...bookmark, id: 'not-yet-pulled' };
  await annotations.save(ref, { tags: [], note: 'Local' }, { base });
  expect((await annotations.get(ref))?.tagsSync?.state).toBe('dirty');
  await annotations.observeTags(ref, { scopeKey: scopeKey(scope), resourceId: 'ai-node', revision: 'ai-r1', value: ['ai'] });
  expect((await annotations.get(ref))?.tags).toEqual([]);
});

test('a dirty unsupported note that becomes plain requires review against the new baseline and can sync a new edit', async () => {
  await annotations.save(bookmark, { tags: [], note: 'Local draft' });
  await annotations.observeNote(bookmark, { ...binding('Markdown', 'r1'), supported: false });
  await annotations.observeNote(bookmark, binding('Plain cloud note', 'r2'));
  let row = (await annotations.get(bookmark))!;
  expect(row.note).toBe('Local draft');
  expect(row.noteSync?.remote).toMatchObject({ supported: true, revision: 'r2' });
  expect(row.noteConflictVersion).toBe(row.noteSync?.version);
  await annotations.save(bookmark, { tags: [], note: 'Reviewed new draft' });
  row = (await annotations.prepareNote(bookmark, scopeKey(scope), 'mapped-colp'))!;
  expect(row.noteIntent).toMatchObject({ revision: 'r2', value: 'Reviewed new draft' });
});

test('a rebased tag draft over the wire limit does not prevent another bookmark from synchronizing', async () => {
  await reconcileBookmarkTags(input());
  await annotations.save(bookmark, { tags: ['base', 'sent'], note: null });
  await reconcileBookmarkTags(input());
  const sent = (await annotations.get(bookmark))!.tagsSync!;
  await annotations.save(bookmark, { tags: ['base', 'sent', ...Array.from({ length: 62 }, (_, i) => `local-${i}`)], note: null });
  await annotations.observeTags(bookmark, { ...sent.remote!, revision: 'merged-r2',
    value: ['base', 'sent', ...Array.from({ length: 62 }, (_, i) => `cloud-${i}`)] }, sent.version);
  expect((await annotations.get(bookmark))?.tags).toHaveLength(126);
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'merged-r2', resourceRevision: 'merged-r2',
    content: { title: bookmark.title, url: bookmark.url, tags: ['base', 'sent', ...Array.from({ length: 62 }, (_, i) => `cloud-${i}`)] } } });
  await expect(reconcileBookmarkTags(input())).resolves.toMatchObject({ staged: 0 });
  expect((await annotations.get(bookmark))?.tags).toHaveLength(126);
  await annotations.save(bookmark, { tags: (await annotations.get(bookmark))!.tags, note: 'Only note changes' });
  expect((await annotations.get(bookmark))?.tags).toHaveLength(126);
});

test.each([403, 410])('a definitive note refusal (%s) blocks a newer draft written before the refusal instead of re-authoring it', async status => {
  await annotations.save(bookmark, { tags: [], note: 'Old draft' });
  const client = { read: vi.fn(async () => binding(null, 'absent', null)), send: vi.fn(async (): Promise<NoteBinding> => {
    await annotations.save(bookmark, { tags: [], note: 'Newer draft' });
    throw new NoteSyncError(status, status === 410 ? 'command_result_expired' : 'insufficient_permission');
  }) };
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  await reconcileBookmarkNotes({ ...input(), clientFor: () => client });
  expect(client.send).toHaveBeenCalledTimes(1);
  expect((await annotations.get(bookmark))?.noteIntent).toBeUndefined();
  expect((await annotations.get(bookmark))?.note).toBe('Newer draft');
  await annotations.save(bookmark, { tags: [], note: 'Reviewed draft' });
  expect((await annotations.prepareNote(bookmark, scopeKey(scope), 'mapped-colp'))?.noteIntent?.value).toBe('Reviewed draft');
});

test('removing AI chips before any annotation row exists retains the explicit clear', async () => {
  await annotations.save(bookmark, { tags: [], note: null }, { base: { tags: ['ai'], sourceTags: [], note: '' } });
  expect((await annotations.get(bookmark))?.tagsSync?.state).toBe('dirty');
  await annotations.observeTags(bookmark, { scopeKey: scopeKey(scope), resourceId: 'mapped-colp', revision: 'ai-r1', value: ['ai'] });
  expect((await annotations.get(bookmark))?.tags).toEqual([]);
});

test('unchanged cloud polls do not broadcast unnecessary UI invalidations', async () => {
  await reconcileBookmarkTags(input());
  expect((await reconcileBookmarkTags(input())).changed).toEqual([]);
  const client = { read: async () => binding('Same note'), send: vi.fn(async () => binding('Same note')) };
  expect(await reconcileBookmarkNotes({ ...input(), clientFor: () => client })).toBe(true);
  expect(await reconcileBookmarkNotes({ ...input(), clientFor: () => client })).toBe(false);
});

test('a batch annotation snapshot confirms a replayed note and keeps a newer draft, with no node-queue settlement evidence', async () => {
  await annotations.observeNote(bookmark, binding(null, 'absent', null));
  await annotations.save(bookmark, { tags: [], note: 'Sent' });
  const prepared = await annotations.prepareNote(bookmark, scopeKey(scope), 'mapped-colp');
  const attempt = prepared!.noteSync!.attempt!;
  expect(attempt.eventId).toBe(prepared!.noteIntent!.commandId);
  expect(await settledMetadataAttempt(f.store, scope, attempt, 'note-r2')).toBeUndefined();
  await annotations.save(bookmark, { tags: [], note: 'Newer' });
  const snapshot = new Map([['mapped-colp', binding('Sent', 'note-r2')]]);
  const send = vi.fn(async () => binding('Sent', 'note-r2'));
  await reconcileBookmarkNotes({ ...input(), readCollection: async () => snapshot, clientFor: () => ({ read: vi.fn(), send }) });
  const row = (await annotations.get(bookmark))!;
  expect(send).toHaveBeenCalledTimes(1);
  expect(row.note).toBe('Newer');
  expect(row.noteSync).toMatchObject({ value: 'Newer', state: 'dirty', remote: { revision: 'note-r2' } });
  expect(row.noteIntent).toBeUndefined();
});
