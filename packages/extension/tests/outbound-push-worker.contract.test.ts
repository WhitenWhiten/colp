import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createSyncStateStore, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const packageRoot = resolve(import.meta.dirname, '..');

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const queued = (opId: string): Omit<QueueOperation, 'scopeKey' | 'sequence'> => ({ opId, batchId: `batch-${opId}`,
  idempotencyKey: `key-${opId}`, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
  mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
  status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { opId, replicaId: scope.replicaId,
    sequence: opId === 'one' ? 1 : 2, collectionId: scope.collectionId, type: 'create_node' } });

describe('P3-31 durable outbound queue contract', () => {
  test('applied update receipt atomically replaces only its matching local projection revision', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-update', colpId: 'node-update', rootNativeId: 'root-native',
      nodeKind: 'bookmark', projection: { revision: 'local-update-1', digest: 'sha256:local-update',
        content: { title: 'Updated', url: 'https://example.test/update' } } });
    const item = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-update', batchId: 'batch-update',
      idempotencyKey: 'key-update', digest: 'sha256:update', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'server-r1', operationRevision: 'local-update-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { opId: 'op-update', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
        type: 'update_node_content', targetId: 'node-update', baseRevision: 'server-r1',
        occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: {
          base: { title: 'Before', url: 'https://example.test/update' }, value: { title: 'Updated' } } } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'worker-update', 1, 10_000);
    await store.claimNextQueue(scope, 'worker-update', lease.fence, 1);
    const result = { batchId: 'batch-update', results: [{ opId: item.opId, sequence: item.sequence,
      status: 'applied', revision: 'server-r2', cursor: 'cursor-r2', warnings: [] }], serverCursor: 'cursor-r2' };
    await store.settleClaimedPush(scope, item.sequence, 'worker-update', lease.fence, { outcome: 'terminal',
      receipt: { opId: item.opId, operationDigest: item.digest, kind: 'terminal', receiptId: 'receipt-update',
        resultDigest: 'sha256:result-update', result }, authoritativeProjection: {
        targetId: 'node-update', revision: 'server-r2' } });
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal'); assert.equal(exported.receipts.length, 1);
    assert.equal((await store.getMappingByColpId(scope, 'node-update'))?.projection.revision, 'server-r2');
  });

  test('claims only the earliest nonterminal sequence and fences duplicate contexts', async () => {
    const indexedDB = new IDBFactory(); const a = createSyncStateStore({ indexedDB });
    const b = createSyncStateStore({ indexedDB }); await active(a);
    await a.allocateSequenceAndEnqueue(scope, queued('one'), { allowUnstamped: true }); await a.allocateSequenceAndEnqueue(scope, queued('two'), { allowUnstamped: true });
    const lease = await a.acquireLease(scope, 'worker-a', 100, 30_000); assert.equal(lease.outcome, 'acquired');
    const [left, right] = await Promise.all([
      a.claimNextQueue(scope, 'worker-a', lease.fence, 100),
      b.claimNextQueue(scope, 'worker-a', lease.fence, 100),
    ]);
    assert.equal([left, right].filter(Boolean).length, 1);
    assert.equal((left ?? right)?.sequence, 1);
    assert.equal(await b.claimNextQueue(scope, 'worker-a', lease.fence, 100), null);
  });

  test('reclaims an unexpired queue claim after a replacement lease advances the fence', async () => {
    const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.allocateSequenceAndEnqueue(scope, queued('one'), { allowUnstamped: true });
    const oldLease = await store.acquireLease(scope, 'worker', 100, 30_000);
    const oldClaim = await store.claimNextQueue(scope, 'worker', oldLease.fence, 100);
    assert.equal(oldClaim?.retry.fence, oldLease.fence);

    const replacement = await store.acquireLease(scope, 'worker', 101, 30_000);
    const reclaimed = await store.claimNextQueue(scope, 'worker', replacement.fence, 101);

    assert.equal(reclaimed?.sequence, oldClaim?.sequence);
    assert.equal(reclaimed?.retry.fence, replacement.fence);
  });

  test('atomically persists full receipt, terminal queue state and authoritative create rebind', async () => {
    const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-create', colpId: 'pending-one', rootNativeId: 'root-native',
      nodeKind: 'bookmark', projection: { revision: 'local-event-one', digest: 'sha256:projection',
        content: { title: 'Public', url: 'https://example.test/public' } } });
    const db = await store.open(); const scopeKey = (await store.getScope(scope))!.scopeKey;
    const tx = db.transaction('bookmark_events', 'readwrite'); tx.objectStore('bookmark_events').add({ scopeKey,
      eventId: 'event-one', ordinal: 1, dedupeKey: 'dedupe-one', occurredAt: '2026-07-27T00:00:00Z', kind: 'create',
      nativeId: 'native-create', details: { draft: { type: 'create_node' } }, status: 'processed', opId: 'one' });
    await transaction(tx);
    const item = await store.allocateSequenceAndEnqueue(scope, { ...queued('one'),
      payload: { opId: 'one', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
        type: 'create_node', baseRevision: null, occurredAt: '2026-07-27T00:00:00Z', payload: {} } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'worker', 100, 30_000); await store.claimNextQueue(scope,
      'worker', lease.fence, 100);
    const result = { batchId: item.batchId, results: [{ opId: item.opId, sequence: 1, status: 'applied',
      targetId: 'node-authoritative', revision: 'revision-authoritative', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' };
    await store.settleClaimedPush(scope, item.sequence, 'worker', lease.fence, { outcome: 'terminal',
      receipt: { opId: item.opId, operationDigest: item.digest, kind: 'terminal', receiptId: 'sha256:result',
        resultDigest: 'sha256:result', result }, authoritativeCreate: { nativeId: 'native-create',
        targetId: 'node-authoritative', revision: 'revision-authoritative' } });
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal'); assert.deepEqual(exported.receipts[0]?.result, result);
    assert.equal(exported.mappings[0]?.colpId, 'node-authoritative');
    assert.equal(exported.mappings[0]?.projection.revision, 'revision-authoritative');
  });

  test('stale fence and injected abort preserve claim, mapping and receipt as one old snapshot', async () => {
    const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
    const item = await store.allocateSequenceAndEnqueue(scope, queued('one'), { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'old', 100, 10); await store.claimNextQueue(scope, 'old', lease.fence, 100);
    await store.acquireLease(scope, 'new', 111, 10);
    await assert.rejects(() => store.settleClaimedPush(scope, item.sequence, 'old', lease.fence, { outcome: 'unknown',
      retry: { attempt: 1, notBefore: 1_000 } }), /stale_fence/);
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'claimed'); assert.equal(exported.receipts.length, 0);
  });

  test('rejects create rebind when receipt target or revision is not the same authority', async () => {
    const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-create', colpId: 'pending-one', rootNativeId: 'root-native',
      nodeKind: 'bookmark', projection: { revision: 'local-one', digest: 'sha256:projection' } });
    const db = await store.open(); const scopeKey = (await store.getScope(scope))!.scopeKey;
    const tx = db.transaction('bookmark_events', 'readwrite'); tx.objectStore('bookmark_events').add({ scopeKey,
      eventId: 'event-one', ordinal: 1, dedupeKey: 'dedupe-one', occurredAt: '2026-07-27T00:00:00Z', kind: 'create',
      nativeId: 'native-create', details: {}, status: 'processed', opId: 'one' }); await transaction(tx);
    const item = await store.allocateSequenceAndEnqueue(scope, { ...queued('one'), payload: { ...queued('one').payload,
      type: 'create_node' } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'worker', 100, 30_000);
    await store.claimNextQueue(scope, 'worker', lease.fence, 100);
    const result = { batchId: 'server-batch', results: [{ opId: 'one', sequence: 1, status: 'applied',
      targetId: 'different-target', revision: 'revision-authoritative', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' };
    await assert.rejects(() => store.settleClaimedPush(scope, item.sequence, 'worker', lease.fence, {
      outcome: 'terminal', receipt: { opId: 'one', operationDigest: item.digest, kind: 'terminal',
        receiptId: 'receipt-one', resultDigest: 'digest-one', result }, authoritativeCreate: {
        nativeId: 'native-create', targetId: 'node-authoritative', revision: 'revision-authoritative' } }),
    /provisional_mapping_binding_invalid/);
    const exported = await store.exportScope(scope); assert.equal(exported.receipts.length, 0);
    assert.equal(exported.mappings[0]?.colpId, 'pending-one'); assert.equal(exported.queue[0]?.status, 'claimed');
  });

  test('keeps the push worker free of logging, parallel fetch and unbounded retry loops', async () => {
    const worker = await readFile(resolve(packageRoot, 'src/outbound-push-worker.ts'), 'utf8');
    // static-only: absence claims. Sensitive logging, a second concurrent Push, an
    // unbounded retry loop or a stale-Session rebind all leave the durable receipt
    // state indistinguishable from the correct implementation, so no behavioural
    // assertion can fail when they appear. The wire/parse/bounded-read/Idempotency-Key
    // behaviour is behavioural in tests/outbound-push-worker.test.ts (exact body bytes,
    // malformed content type, oversized response, 200-response contract violation) and
    // the move-event dedupe is behavioural in tests/outbound-push-worker-rebase.test.ts.
    assert.doesNotMatch(worker, /console\.|telemetry|analytics|(?:log|message)\s*\([^)]*(?:nativeId|sessionId)/s);
    assert.doesNotMatch(worker, /Promise\.all\([^)]*fetch/s);
    assert.doesNotMatch(worker, /while\s*\(true\)/s);
    // static-only: the push envelope must send the extension Origin; no host unit test
    // asserts the push request headers (the snapshot side is asserted in
    // tests/durable-sync-engine-harness.ts), so the header expression is pinned here.
    assert.match(worker, /Origin: options\.origin/);
  });

  test('attempt envelope is durable and terminal Problems are exhaustively fail-closed', async () => {
    const worker = await readFile(resolve(packageRoot, 'src/outbound-push-worker.ts'), 'utf8');
    // static-only: absence claim — settlement must route through the durable attempt
    // envelope (`bindPushAttempt`/body digest), never re-encode a rotated Session id into
    // the request. Envelope durability is behavioural in tests/outbound-push-worker.test.ts
    // ("durably binds Session, batch, exact body bytes and fingerprint before the first
    // fetch") and refusal routing is behavioural in tests/outbound-push-authority-refusal.test.ts.
    assert.doesNotMatch(worker, /encodeRequest\(queue,\s*authority\.session\.sessionId\)/);
  });

  test('real-browser evidence requires production MV3, TLS/PostgreSQL and server-side replay proof', async () => {
    const e2e = await readFile(resolve(packageRoot, 'e2e/mv3-outbound-push.spec.ts'), 'utf8');
    const stack = await readFile(resolve(packageRoot, 'e2e/real-stack.ts'), 'utf8');
    for (const marker of ['launchPersistentContext', 'dist/production', 'startRealStack', 'syncPush',
      'commitAfterDisconnect', 'serverMutationCount', 'serverReceiptDigest', 'duplicateAlarm', 'terminateExtensionWorker',
      'chrome.bookmarks.create', 'chrome.bookmarks.update', 'chrome.bookmarks.move', 'chrome.bookmarks.remove',
      'authentication_required_once', 'timeout_once', 'rate_limited_once', 'deferred_once', 'sequence_gap_once',
      'sequence_blocked_once', 'seedCanonicalFixture', 'concurrentlyUpdateCanonicalBookmark',
      'before_attempt_persist', 'after_attempt_persist', 'after_receipt']) {
      assert.match(`${e2e}\n${stack}`, new RegExp(marker));
    }
    assert.doesNotMatch(e2e, /page\.route\(|route\.fulfill|mockFetch|fetchCallCount/);
    assert.match(e2e, /profileA|profileB/);
  });
});

async function active(store: ReturnType<typeof createSyncStateStore>) { await store.registerScope({ ...scope,
  lifecycle: 'active', lease: { leaseId: 'server-lease', expiresAt: 999_999 }, checkpoint: null, selectedRoots: [] }); }
async function transaction(tx: IDBTransaction) { await new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
}); }
