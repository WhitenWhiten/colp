import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createMetadataSyncPolicyStore } from '../src/metadata-sync-policy.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { needsReplicaRebuild } from '../src/durable-sync-engine-errors.js';
import { terminalFreezeReasonCopy, syncAttentionTerminalCode } from '../src/sync-attention-ui.js';
import { installOutboundPushIndexedDb, setup, scope, operation, json } from './outbound-push-worker-harness.js';
installOutboundPushIndexedDb();

test('opt-out stops an immutable retry, preserves later work and exposes a durable reset exit', async () => {
  const f = await setup(), policy = createMetadataSyncPolicyStore(new MemoryStorageArea());
  let calls = 0;
  const api = {} as Parameters<typeof createSyncEffectAuthority>[0]['api'];
  const effects = createSyncEffectAuthority({ scope, api, context: { generation: 1, signal: new AbortController().signal },
    currentScope: async () => scope, assertWritable: async () => undefined, metadataPolicy: policy,
    fetch: async () => { calls++; throw new Error('network offline'); } });
  // Settle ordinary work, then persist a real failed metadata attempt.
  await createOutboundPushWorker({ ...f.options, fetch: async () => json(200, { batchId: f.queued.batchId,
    results: [{ opId: f.queued.opId, sequence: 1, status: 'noop', warnings: [] }], serverCursor: 'cursor-1' }) }).drain();
  const add = async (sequence: number, tags?: string[]) => f.store.allocateSequenceAndEnqueue(scope, {
    opId: `op-${sequence}`, batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}`,
    digest: `sha256:operation-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: `local-${sequence}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...operation, opId: `op-${sequence}`, sequence,
      payload: { ...operation.payload as object, ...(tags ? { tags } : {}) } },
  }, { allowUnstamped: true });
  await add(2, ['private']); await add(3);
  await policy.write(scope, true);
  assert.equal((await createOutboundPushWorker({ ...f.options, fetch: effects.fetch }).drain()).outcome, 'unknown');
  const attempted = (await f.store.listQueue(scope)).find(row => row.sequence === 2)!;
  await policy.write(scope, false); f.clock.now = attempted.retry.notBefore;
  const worker = createOutboundPushWorker({ ...f.options, fetch: effects.fetch, allowRecoveryFrozenPush: () => true });
  assert.equal((await worker.drain()).outcome, 'recovery');
  assert.equal(calls, 1);
  const queue = await f.store.listQueue(scope), denied = queue.find(row => row.sequence === 2)!;
  assert.equal(denied.status, 'blocked'); assert.deepEqual(denied.attempt, attempted.attempt);
  assert.equal(queue.find(row => row.sequence === 3)!.status, 'pending');
  assert.equal((await f.store.getEngineState(scope))?.lastError, 'metadata_sync_disabled');
  await policy.write(scope, true);
  assert.equal((await worker.drain()).outcome, 'recovery'); assert.equal(calls, 1);
  assert.equal(needsReplicaRebuild('metadata_sync_disabled'), true);
  assert.equal(syncAttentionTerminalCode(undefined, 'metadata_sync_disabled'), 'metadata_sync_disabled');
  assert.match(terminalFreezeReasonCopy('metadata_sync_disabled'), /Reset sync/);
  await f.store.retireScope(scope, { retiredAt: f.clock.now, reason: 'user_replica_rebuild' });
  const archive = await f.store.exportArchive(scope);
  assert.deepEqual((archive.queue as typeof queue).find(row => row.sequence === 2)!.attempt, attempted.attempt);
  assert.equal((archive.queue as typeof queue).find(row => row.sequence === 3)!.status, 'pending');
  f.store.close();
});
