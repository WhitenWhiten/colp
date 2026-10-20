import { expect, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { metadataSyncFetch } from '../src/metadata-sync-fetch.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { scope } from './bookmark-event-queue-harness.js';
import { metadataBoundaryFixture } from './push-final-metadata-harness.js';

for (const change of ['none', 'private', 'exclusion', 'mapping_loss', 'detach'] as const)
test(`a real metadata queue checks ${change} after metadata storage admission`, async () => {
  const f = await metadataBoundaryFixture();
  try {
    let changed = false;
    f.hooks.duringAdmission = async () => {
      if (changed) return; changed = true;
      if (change === 'private') f.api.put({ ...f.bookmark, parentId: 'root-private' });
      else if (change === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
        nativeId: f.bookmark.id, rootNativeId: 'root-selected', decisionId: 'metadata-admission', generation: scope.generation });
      else if (change === 'mapping_loss') await f.store.deleteMapping(scope, 'root-private');
      else if (change === 'detach') {
        const mount = (await f.store.listMountBindings(scope)).find(row => row.nativeRootId === 'root-selected')!;
        await f.store.putMountBinding(scope, { ...mount, status: 'detached' });
      }
    };
    await createOutboundPushWorker(f.options).drain(); expect(changed).toBe(true);
    const row = (await f.store.getQueueByOpId(scope, f.original.opId))!;
    if (change === 'none') {
      expect(f.sent).toHaveLength(1); expect(await f.store.getQueueReceipt(scope, row.sequence)).toMatchObject({ kind: 'terminal' });
    } else {
      expect(f.sent).toEqual([]); expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
      expect(row).toMatchObject({ payload: f.original.payload, digest: f.original.digest,
        sequence: f.original.sequence, idempotencyKey: f.original.idempotencyKey,
        ...(change === 'mapping_loss' ? { status: 'unknown', recovery: { code: 'upload_boundary_unavailable' } }
          : { status: 'rejected' }) });
    }
    expect((await f.annotations.get(f.bookmark))?.note).toBe('Private draft');
  } finally { f.close(); }
});

test('an additional real metadata transport forwards the final queue proof through its own admission', async () => {
  const f = await metadataBoundaryFixture();
  try {
    const wrapped = metadataSyncFetch(scope, f.options.fetch!, f.policy);
    // Finish construction-time consent before injecting at dispatch admission.
    await f.policy.capture(scope);
    f.hooks.duringAdmission = async () => { f.api.put({ ...f.bookmark, parentId: 'root-private' }); };
    await createOutboundPushWorker({ ...f.options, fetch: wrapped }).drain();
    expect(f.sent).toEqual([]); expect(await f.store.getQueueReceipt(scope, f.original.sequence)).toBeNull();
    expect(await f.store.getQueueByOpId(scope, f.original.opId)).toMatchObject({ status: 'rejected',
      payload: f.original.payload, digest: f.original.digest, sequence: f.original.sequence });
  } finally { f.close(); }
});

for (const change of ['off', 'off_on', 'other_scope', 'authority'] as const)
test(`final metadata admission preserves ${change} while the native proof is awaiting`, async () => {
  const f = await metadataBoundaryFixture(); let attempted: QueueOperation | undefined;
  try {
    f.hooks.afterFinalProof = async () => {
      f.hooks.afterFinalProof = undefined;
      if (change === 'authority') await f.fence.revoke();
      else if (change === 'other_scope') await f.policy.write({ ...scope, collectionId: 'another' }, false);
      else { await f.policy.write(scope, false); if (change === 'off_on') await f.policy.write(scope, true); }
    };
    await createOutboundPushWorker({ ...f.options, boundary: async (point, row) => {
      if (point === 'after_attempt_persist') attempted = row;
    } }).drain();
    expect(attempted?.attempt).toBeDefined();
    if (change === 'other_scope') {
      expect(f.sent).toHaveLength(1); expect(await f.store.getQueueReceipt(scope, f.original.sequence)).toMatchObject({ kind: 'terminal' });
    } else {
      expect(f.sent).toEqual([]); expect(await f.store.getQueueReceipt(scope, f.original.sequence)).toBeNull();
      expect(await f.store.getQueueByOpId(scope, f.original.opId)).toMatchObject({ attempt: attempted!.attempt,
        digest: f.original.digest, payload: f.original.payload, sequence: f.original.sequence, idempotencyKey: f.original.idempotencyKey,
        ...(change === 'authority' ? { status: 'unknown', recovery: { code: 'authority_fenced' } }
          : { status: 'blocked', recovery: { code: 'metadata_sync_disabled' } }) });
    }
  } finally { f.close(); }
});
