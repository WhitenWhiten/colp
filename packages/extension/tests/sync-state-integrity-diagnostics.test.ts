import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { STORES } from '../src/sync-state/schema.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const other = { ...scope, accountId: 'account-b' } as SyncScope;
const SECRETS = ['SECRET-TITLE', 'SECRET-MAPPING', 'SECRET-QUEUE', 'SECRET-BODY', 'SECRET-NOTE',
  'private.example', 'token-value'];

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('integrity audit localizes every bad record by store/key/code without leaking content', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  await store.registerScope({ ...other, lifecycle: 'active', lease: { leaseId: 'lease-b', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  const key = (await store.getScope(scope))!.scopeKey;
  const key2 = (await store.getScope(other))!.scopeKey;
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORES.queue, STORES.bookmarkEvents, STORES.mappings, STORES.pullPages,
      STORES.engine, STORES.recovery], 'readwrite');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
    // Two invalid queue rows in one scope: the first must not hide the second.
    tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 7, opId: 'op-bad-7', status: 'mystery',
      payload: { title: 'SECRET-QUEUE' } });
    tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 9, opId: 'op-bad-9', status: 'mystery',
      payload: { title: 'SECRET-QUEUE' } });
    // Another scope is localized independently.
    tx.objectStore(STORES.queue).put({ scopeKey: key2, sequence: 8, opId: 'op-bad-other', status: 'mystery' });
    tx.objectStore(STORES.bookmarkEvents).put({ scopeKey: key, eventId: 'bad-event', dedupeKey: 'dedupe-bad',
      occurredAt: '2026-10-01T00:00:00.000Z', kind: 'change', nativeId: 'native-bad', ordinal: 1,
      status: 'broken', opId: null,
      details: { title: 'SECRET-TITLE', url: 'https://private.example/bookmark', body: 'SECRET-BODY',
        note: 'SECRET-NOTE' } });
    tx.objectStore(STORES.mappings).put({ scopeKey: key, nativeId: 'bad-native', colpId: 'bad-colp',
      rootNativeId: 'native-root', nodeKind: 'not-a-kind',
      projection: { revision: 'r', digest: 'sha256:r', content: { title: 'SECRET-MAPPING',
        url: 'https://private.example/mapping' } } });
    tx.objectStore(STORES.pullPages).put({ scopeKey: key, pageId: 'bad-page', state: 'nonsense',
      previousCursor: 'cursor', nextCursor: 'cursor', pageDigest: 'sha256:bad', title: 'SECRET-TITLE' });
    tx.objectStore(STORES.engine).put({ scopeKey: key });
    tx.objectStore(STORES.recovery).put({ scopeKey: key, snapshotId: 'bad-snapshot' });
  });

  await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
  const exported = await store.exportDiagnostics();
  assert.equal(exported.mode, 'diagnostic_read_only');
  const corruption = exported.records.find((record) => record.kind === 'corruption' &&
    Array.isArray(record.details)) as { readonly problems: string[]; readonly details: Array<Record<string, unknown>>;
    readonly truncated?: boolean } | undefined;
  assert.ok(corruption, 'a corruption diagnostic with structured details is persisted');
  assert.ok(Array.isArray(corruption.problems) && corruption.problems.every((code) => typeof code === 'string'));
  assert.equal(corruption.problems.filter((code) => code === 'bad_record').length, 1);
  const details = corruption.details;
  assert.ok(details.length >= 6 && details.length <= 32);
  for (const detail of details) {
    assert.deepEqual(Object.keys(detail).sort(), ['code', 'key', 'scope', 'store']);
    assert.equal(typeof detail.store, 'string'); assert.equal(typeof detail.key, 'string');
    assert.equal(typeof detail.scope, 'string'); assert.equal(typeof detail.code, 'string');
  }
  const queue = details.filter((detail) => detail.store === STORES.queue);
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=7')));
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=9')), 'second bad row is not hidden');
  assert.ok(queue.some((detail) => String(detail.key).includes('sequence=8')), 'other scope is localized');
  assert.equal(new Set(queue.map((detail) => detail.scope)).size, 2, 'both scopes have distinct references');
  assert.ok(details.some((detail) => detail.store === STORES.bookmarkEvents
    && String(detail.key).includes('eventId=bad-event') && detail.code === 'bookmark_event_status_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.mappings
    && String(detail.key).includes('nativeId=bad-native') && detail.code === 'node_kind_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.pullPages
    && String(detail.key).includes('pageId=bad-page') && detail.code === 'pull_page_invalid'));
  assert.ok(details.some((detail) => detail.store === STORES.engine && detail.key === 'engine' && typeof detail.code === 'string' && detail.code.length > 0));
  assert.ok(details.some((detail) => detail.store === STORES.recovery
    && String(detail.key).includes('snapshotId=bad-snapshot') && detail.code === 'recovery_header_invalid'));
  const diagnostic = JSON.stringify(corruption);
  for (const secret of SECRETS) assert.equal(diagnostic.includes(secret), false, `no raw content: ${secret}`);
  store.close();
});

test('a relation-only corruption keeps the public problem array and writes no record details', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-a', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'rev', cursor: 'cursor' }, selectedRoots: [] });
  await store.injectCorruptionForTest('orphan_receipt', scope);
  await assert.rejects(() => store.auditIntegrity(), /corruption_detected/);
  const exported = await store.exportDiagnostics();
  const corruption = exported.records.find((record) => record.kind === 'corruption'
    && !Array.isArray(record.details)) as { readonly problems?: readonly string[] } | undefined;
  assert.ok(corruption?.problems?.includes('orphan_receipt'));
  store.close();
});
