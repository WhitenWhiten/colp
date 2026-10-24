import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';

/**
 * W2A-03: every Reset, sign-out and remount copied the whole scope into an archive, and about three quarters of
 * its bytes were the pull facts (two diagnostics rows per applied remote operation) that nothing reads from an
 * archive. The archive keeps what a rebuild's hints, the metadata proofs and a support export use.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const key = scopeKey(scope);
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function withFacts() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
    checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
  const tx = (await store.open()).transaction([STORES.diagnostics, STORES.queue], 'readwrite'); const done = transactionDone(tx);
  const diagnostics = tx.objectStore(STORES.diagnostics);
  for (let index = 1; index <= 3; index += 1) {
    diagnostics.put({ id: `pull-terminal:${key}:op-${index}`, scopeKey: key, kind: 'pull_terminal_fact', opId: `op-${index}`, effectDigest: 'sha256:e' });
    diagnostics.put({ id: `pull-applied:${key}:op-${index}`, scopeKey: key, kind: 'pull_applied_fact', opId: `op-${index}`, effectDigest: 'sha256:e' });
  }
  diagnostics.put({ id: `queue-quarantine:${key}:9`, scopeKey: key, kind: 'queue_quarantine', code: 'queue_row_unreadable', sequence: 9 });
  diagnostics.put({ id: `capture-net:${key}`, scopeKey: key, kind: 'capture_net_node_failures', details: { failed: 1, attempted: 4 } });
  tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 1, opId: 'op-unsent', batchId: 'batch', idempotencyKey: 'idem',
    digest: 'sha256:unsent', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'rev', operationRevision: 'local-1',
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node', targetId: 'node-1' } });
  await done;
  return store;
}
const kinds = (rows: readonly Record<string, unknown>[]) => rows.map(row => row.kind).sort();

test('a Reset archive drops the pull facts and keeps everything else, including the unsent queue and the damaged-row evidence', async () => {
  const store = await withFacts();
  assert.equal(kinds((await store.exportScope(scope)).diagnostics as never).filter(kind => String(kind).startsWith('pull_')).length, 6,
    'the live scope and its support export keep the facts');
  await store.retireScope(scope, { retiredAt: 1_700_000_000_000, reason: 'user_replica_rebuild' });
  const archive = await store.exportArchive(scope) as unknown as { diagnostics: Record<string, unknown>[]; queue: unknown[]; omittedPullFacts: number; reason: string };
  assert.deepEqual(kinds(archive.diagnostics), ['capture_net_node_failures', 'queue_quarantine']);
  assert.equal(archive.omittedPullFacts, 6);
  assert.equal(archive.queue.length, 1, 'the unsent work is archived whole');
  assert.equal(archive.reason, 'user_replica_rebuild');
});

test('a sign-out archive is slim too', async () => {
  const store = await withFacts();
  await store.cleanupAccount({ environment: scope.environment, serverId: scope.serverId, accountId: scope.accountId,
    browserProfileId: scope.browserProfileId });
  const archive = await store.exportArchive(scope) as unknown as { diagnostics: Record<string, unknown>[]; omittedPullFacts: number; reason: string };
  assert.deepEqual(kinds(archive.diagnostics), ['capture_net_node_failures', 'queue_quarantine']);
  assert.equal(archive.omittedPullFacts, 6);
  assert.equal(archive.reason, 'logout_cleanup');
});
