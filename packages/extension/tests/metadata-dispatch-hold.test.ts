import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createMetadataSyncPolicyStore } from '../src/metadata-sync-policy.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { installOutboundPushIndexedDb, json, operation, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F6 / W2C-14: a queued tags/description change that was never sent, and whose consent was
 * withdrawn before it left, used to freeze the whole replica (`metadata_sync_disabled`, exit
 * Reset). It is one item: it is held, the rest of the lane uploads, and nothing freezes. A change
 * whose attempt may have been received keeps the old, evidence-preserving exit
 * (tests/metadata-dispatch-recovery.test.ts).
 */
function applied(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
  const op = body.operations[0]!;
  return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
    targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
}

test('a never-sent tags change refused by the consent gate is held as one item and the lane goes on', async () => {
  const f = await setup(); const policy = createMetadataSyncPolicyStore(new MemoryStorageArea()); const sent: string[] = [];
  const effects = createSyncEffectAuthority({ scope, api: {} as Parameters<typeof createSyncEffectAuthority>[0]['api'],
    context: { generation: 1, signal: new AbortController().signal }, currentScope: async () => scope,
    assertWritable: async () => undefined, metadataPolicy: policy,
    fetch: async (_url, init) => { sent.push((JSON.parse(String(init?.body)) as { operations: Array<{ opId: string }> }).operations[0]!.opId);
      return applied(init); } });
  const add = (sequence: number, tags?: string[]) => f.store.allocateSequenceAndEnqueue(scope, {
    opId: `op-${sequence}`, batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}`,
    digest: `sha256:operation-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: `local-${sequence}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { ...operation, opId: `op-${sequence}`, sequence, payload: { ...operation.payload as object, ...(tags ? { tags } : {}) } },
  }, { allowUnstamped: true });
  await add(2, ['private']); await add(3);
  await policy.write(scope, false);
  const worker = createOutboundPushWorker({ ...f.options, fetch: effects.fetch });
  assert.equal((await worker.drain()).outcome, 'terminal');
  const rows = await f.store.listQueue(scope);
  assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
    ['op-push-1', 'terminal', undefined], ['op-2', 'set_aside', 'metadata_sync_disabled'], ['op-3', 'terminal', undefined]]);
  assert.equal(rows[1]!.attempt, undefined, 'the bytes that carried the tags are not kept for a later send');
  assert.deepEqual(sent, ['op-push-1', 'op-3'], 'the tags change never left');
  const engine = await f.store.getEngineState(scope);
  assert.notEqual(engine?.recoveryFrozen, true); assert.notEqual(engine?.lastError, 'metadata_sync_disabled');
  assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
  f.store.close();
});
