import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createReplicaRebuilder } from '../src/replica-rebuild.js';
import { readReplicaRepairCapability } from '../src/replica-repair-capability.js';
import type { QueueOperation, ReceiptInput } from '../src/sync-state-store.js';
import { setupRetirement } from './replica-retirement-harness.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function setup() { const f = await setupRetirement(); fixtures.push(f); return f; }

for (const mismatch of ['operationDigest', 'opId', 'sequence', 'scopeKey'] as const) {
  test(`a reopened database with a stale ${mismatch} receipt cannot authorize archive without server retirement`, async () => {
    const f = await setup(), row = f.original[0]!;
    // Recovery boundary: an old/restored or damaged IDB image can contain a
    // structurally valid receipt with the wrong operation binding. Normal
    // settlement APIs reject this (covered below). Persist the damaged fact,
    // close the connection, then use the real public store and Reset flow.
    const receipt = { scopeKey: row.scopeKey, sequence: row.sequence, opId: row.opId,
      operationDigest: row.digest, kind: 'terminal', receiptId: 'restored-receipt',
      resultDigest: 'sha256:restored-result', [mismatch]: mismatch === 'sequence' ? row.sequence + 10 : 'wrong-binding' };
    const tx = (await f.store.open()).transaction('receipts', 'readwrite');
    tx.objectStore('receipts').put(receipt);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
    f.store.close();
    assert.equal((await f.store.listQueue(f.scope))[0]!.digest, row.digest);
    const capability = await readReplicaRepairCapability(f.store, f.scope);
    assert.equal(capability.retirementRequired, true);
    assert.equal(capability.rebuildAvailable, false);
    assert.equal(capability.reason, 'upload_outcome_unsettled');
    const withoutRetirement = createReplicaRebuilder({ ...f.deps, serverRetirement: undefined });
    assert.deepEqual(await withoutRetirement.handle({ kind: 'known.scope.rebuild.preview' }),
      { ok: false, code: 'upload_outcome_unsettled' });
    const preview = await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(preview.ok && 'preview' in preview);
    assert.equal(preview.preview.retirementRequired, true);
    f.setResponse(async () => new Response(null, { status: 409 }));
    assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'retirement_pending' });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.store.listQueue(f.scope), f.original);
    assert.deepEqual(await f.credentials.loadBinding(), f.binding);
    await assert.rejects(f.store.exportArchive(f.scope), /archive_not_found/);
  });
}

test('ordinary settlement rejects a mismatched digest; a real matching terminal receipt needs no retirement', async () => {
  const f = await setup(), row = f.original[0]!;
  const receipt = { kind: 'terminal' as const, opId: row.opId, operationDigest: 'sha256:wrong',
    receiptId: 'verified-terminal', resultDigest: 'sha256:result' };
  await assert.rejects(f.store.completeQueueWithReceipt(f.scope, row.sequence, receipt), /digest_mismatch/);
  assert.equal(await f.store.getQueueReceipt(f.scope, row.sequence), null);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
  await f.store.completeQueueWithReceipt(f.scope, row.sequence, { ...receipt, operationDigest: row.digest });
  f.store.close();
  const capability = await readReplicaRepairCapability(f.store, f.scope);
  assert.equal(capability.retirementRequired, false);
  assert.equal(capability.rebuildAvailable, true);
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
  assert.equal(f.requests.length, 0);
  const archive = await f.store.exportArchive(f.scope);
  assert.equal((archive.receipts as ReceiptInput[])[0]?.operationDigest, row.digest);
  assert.equal((archive.queue as QueueOperation[])[0]?.status, 'terminal');
  assert.deepEqual((archive.queue as QueueOperation[])[0]?.attempt, row.attempt);
});
