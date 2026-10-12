import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createLocalBatchStore, LOCAL_BATCH_DATABASE } from '../src/bookmark-batch-local-store.js';
import { confirmBatch, previewOrThrow, undoBatch } from '../src/bookmark-batch-executor.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';

test('unbound native delete requires confirmation and persists replay without creating sync work', async () => {
  const indexedDB = new IDBFactory();
  const store = createLocalBatchStore(indexedDB), local = store.local;
  const api = createMemoryBookmarks();
  const preview = await previewOrThrow({ local, api, kind: 'delete', nativeIds: ['bm-1'] });
  const command = { local, api, kind: 'delete' as const, nativeIds: ['bm-1'],
    commandId: 'local-delete', previewDigest: preview.digest };
  await assert.rejects(() => confirmBatch(command), /confirm_required/);
  assert.ok(api.node('bm-1'));
  await confirmBatch({ ...command, secondConfirm: true });
  assert.equal(api.node('bm-1'), undefined);
  await store.close();
  const reopened = createLocalBatchStore(indexedDB);
  const replay = await confirmBatch({ ...command, local: reopened.local, secondConfirm: true });
  assert.equal(replay.reused, true);
  assert.deepEqual(api.mutations, ['remove:bm-1']);
  assert.deepEqual((await indexedDB.databases()).map(database => database.name), [LOCAL_BATCH_DATABASE]);
  const undone = await undoBatch({ local: reopened.local, api, planId: replay.planId, commandId: command.commandId });
  assert.equal(undone.state, 'undone');
  const children = (await api.get('bar'))[0]!.children!;
  assert.equal(children[0]?.title, 'One');
  assert.equal(children[0]?.url, 'https://a.test/one');
  await undoBatch({ local: reopened.local, api, planId: replay.planId, commandId: command.commandId });
  assert.equal(api.mutations.filter(mutation => mutation.startsWith('create:')).length, 1);
  await reopened.close();
});

test('unbound batches preserve protected roots and reject an edited delete preview', async () => {
  const store = createLocalBatchStore(new IDBFactory()), local = store.local;
  const api = createMemoryBookmarks();
  const protectedPreview = await previewOrThrow({ local, api, kind: 'delete', nativeIds: ['bar'] });
  await assert.rejects(() => confirmBatch({ local, api, kind: 'delete', nativeIds: ['bar'],
    commandId: 'protected-delete', previewDigest: protectedPreview.digest, secondConfirm: true }), /protected_root/);
  const preview = await previewOrThrow({ local, api, kind: 'delete', nativeIds: ['bm-1'] });
  await api.update('bm-1', { title: 'Edited after preview' });
  await assert.rejects(() => confirmBatch({ local, api, kind: 'delete', nativeIds: ['bm-1'],
    commandId: 'stale-delete', previewDigest: preview.digest, secondConfirm: true }), /stale_revision/);
  assert.ok(api.node('bm-1'));
  assert.ok(api.node('bar'));
  await store.close();
});
