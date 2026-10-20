import { expect } from 'vitest';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { assertQueuedUploadBatchAllowed } from '../src/queued-upload-batch-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { bookmark, scope } from './bookmark-event-queue-harness.js';
import { setupBootstrapRace } from './bootstrap-event-race-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { rejoinSession, REJOIN_TOKEN } from './rejoin-http-fixture.js';

export async function batchBoundaryFixture(count = 8) {
  const f = await setupBootstrapRace(), nodes = [f.node];
  for (let index = 1; index < count; index++) {
    const node = bookmark(`batch-native-${index}`, 'root-selected', index, `Batch ${index}`, `https://batch.test/${index}`);
    f.api.put(node); nodes.push(node);
  }
  await f.coordinator.resume({ ...f.resumed, localFacts: nodes.map(node => ({ nativeId: node.id,
    parentNativeId: node.parentId, mountNativeRootId: 'root-selected', kind: 'bookmark', title: node.title, url: node.url })) });
  const original = await f.store.listQueue(scope); expect(original).toHaveLength(count);
  const reads = { facts: 0, mappingFacts: 0, nativeCalls: 0, nativeIds: [] as string[], individualCalls: 0, batchProofs: 0 };
  const hooks: { afterFacts?: (ordinal: number) => Promise<void>;
    beforeMany?: (ids: readonly string[]) => Promise<void>;
    afterProof?: (ordinal: number) => Promise<void> } = {};
  const store = { ...f.store, readQueuedUploadBoundaryFacts: async (...args: Parameters<typeof f.store.readQueuedUploadBoundaryFacts>) => {
    const facts = await f.store.readQueuedUploadBoundaryFacts(...args);
    reads.facts++; reads.mappingFacts += facts.mappings.length;
    await hooks.afterFacts?.(reads.facts); return facts;
  } };
  const parentOf = async (id: string) => { reads.nativeCalls++; reads.nativeIds.push(id); return (await f.api.get(id))[0]?.parentId; };
  const getMany = async (ids: readonly string[]) => {
    await hooks.beforeMany?.(ids); reads.nativeCalls++; reads.nativeIds.push(...ids);
    return (await Promise.all(ids.map(id => f.api.get(id)))).flat();
  };
  const guard = async (queue: QueueOperation) => {
    reads.individualCalls++; await assertQueuedUploadAllowed({ store, scope, queue, parentOf });
  };
  const batchGuard = async (rows: readonly QueueOperation[]) => {
    const ordinal = ++reads.batchProofs;
    await assertQueuedUploadBatchAllowed({ store, scope, rows, parentOf, getMany });
    await hooks.afterProof?.(ordinal);
  };
  let now = Date.now(); const sent: string[] = [];
  const session = { ...await rejoinSession(scope), maxBatchOperations: 50 };
  const options: Parameters<typeof createOutboundPushWorker>[0] = { store, scope, now: () => now,
    initialBatchOperations: 50, ownerId: () => 'batch-boundary', schedule: () => undefined, random: () => 0,
    endpoints: async () => endpoints,
    sessions: { get: async () => ({ credential: { accessToken: REJOIN_TOKEN, subject: scope.accountId }, session }) },
    assertUploadAllowed: guard, assertBatchUploadAllowed: batchGuard,
    dispatch: async (queue, send) => { await guard(queue); return send(); },
    dispatchBatch: async (rows, send) => { await batchGuard(rows); return send(); },
    fetch: async (_url, init) => {
      sent.push(String(init?.body));
      const request = JSON.parse(sent.at(-1)!);
      return Response.json({ batchId: request.batchId, serverCursor: 'after-batch',
        results: request.operations.map((row: { opId: string; sequence: number }) => ({ opId: row.opId,
          sequence: row.sequence, status: 'applied', targetId: `batch-cloud-${row.sequence}`,
          revision: `revision-${row.sequence}`, cursor: `cursor-${row.sequence}`, warnings: [] })) });
    } };
  return { ...f, nodes, original, options, sent, reads, hooks, guard, batchGuard, getMany,
    advance: () => { now += 600_000; } };
}

export async function assertUnsentOriginals(f: Awaited<ReturnType<typeof batchBoundaryFixture>>) {
  expect(f.sent).toEqual([]);
  for (const row of f.original) {
    expect(await f.store.getQueueByOpId(scope, row.opId)).toMatchObject({ sequence: row.sequence,
      digest: row.digest, payload: row.payload, idempotencyKey: row.idempotencyKey });
    expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
  }
}
