import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { bookmark, folder, scope } from './bookmark-event-queue-harness.js';
import { setupBootstrapRace } from './bootstrap-event-race-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { rejoinSession, REJOIN_TOKEN } from './rejoin-http-fixture.js';

/** Real confirmed bootstrap, native tree, queue and worker. The previous
 * library is represented by real native/mapping pairs outside this new mount;
 * none of that unrelated history can authorize the new upload. */
async function fixture(history: number, lostResponse = false) {
  const f = await setupBootstrapRace();
  for (let index = 0; index < history; index++) {
    const node = bookmark(`history-${index}`, 'root-unselected', index, `History ${index}`, `https://history.test/${index}`);
    f.api.put(node);
    await f.store.putMapping(scope, { nativeId: node.id, colpId: `history-colp-${index}`,
      rootNativeId: 'root-unselected', parentNativeId: 'root-unselected', nodeKind: 'bookmark',
      projection: { revision: `history-r-${index}`, digest: `history-d-${index}`,
        content: { title: node.title, url: node.url } } });
  }
  const nodes = [f.node];
  for (let index = 1; index < 8; index++) {
    const node = bookmark(`new-${index}`, 'root-selected', index, `New ${index}`, `https://new.test/${index}`);
    f.api.put(node); nodes.push(node);
  }
  await f.coordinator.resume({ ...f.resumed, localFacts: nodes.map(node => ({ nativeId: node.id,
    parentNativeId: node.parentId, mountNativeRootId: 'root-selected', kind: 'bookmark', title: node.title, url: node.url })) });
  const original = await f.store.listQueue(scope);
  expect(original).toHaveLength(nodes.length);
  let guardCalls = 0, mappingRows = 0, guardMappingRows = 0, pointReads = 0, scans = 0, mappingReadMs = 0, now = Date.now();
  const measureMappings = (guard: boolean) => async (...args: Parameters<typeof f.store.listMappings>) => {
    const at = performance.now(), rows = await f.store.listMappings(...args);
    mappingReadMs += performance.now() - at; scans++; mappingRows += rows.length;
    if (guard) guardMappingRows += rows.length; return rows;
  };
  const observed = { ...f.store, listMappings: measureMappings(false) };
  const guarded = { ...f.store, listMappings: measureMappings(true),
    getMappingByColpId: async (...args: Parameters<typeof f.store.getMappingByColpId>) => {
      pointReads++; return f.store.getMappingByColpId(...args);
    } };
  const session = { ...await rejoinSession(scope), maxBatchOperations: 50 };
  const sent: string[] = [];
  const options = { scope, store: observed, now: () => now, schedule: () => undefined, random: () => 0,
    ownerId: () => 'first-sync-read-budget', endpoints: async () => endpoints, initialBatchOperations: 50,
    sessions: { get: async () => ({ credential: { accessToken: REJOIN_TOKEN, subject: scope.accountId }, session }) },
    assertUploadAllowed: async (queue: typeof original[number]) => {
      guardCalls++; await assertQueuedUploadAllowed({ store: guarded, scope, queue,
        parentOf: async id => (await f.api.get(id))[0]?.parentId });
    }, fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body); sent.push(body);
      if (lostResponse && sent.length === 1) throw new Error('lost_response');
      const request = JSON.parse(body);
      return Response.json({ batchId: request.batchId, serverCursor: 'after-first-sync',
        results: request.operations.map((operation: { opId: string; sequence: number }) => ({ opId: operation.opId,
          sequence: operation.sequence, status: 'applied', targetId: `created-${operation.sequence}`,
          revision: `revision-${operation.sequence}`, cursor: `cursor-${operation.sequence}`, warnings: [] })) });
    } };
  return { ...f, nodes, original, options, sent, advance: () => { now += 600_000; },
    reads: () => ({ guardCalls, scans, mappingRows, guardMappingRows, pointReads, mappingReadMs: Math.round(mappingReadMs) }) };
}

for (const history of [0, 1_024]) test(`first-sync dispatch reads only current boundary identities with ${history} unrelated mappings`, async () => {
  const f = await fixture(history);
  try {
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('terminal');
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(f.sent[0]!).operations.map((row: { opId: string }) => row.opId)).toEqual(f.original.map(row => row.opId));
    for (const row of f.original) {
      const persisted = await f.store.getQueueByOpId(scope, row.opId);
      expect(persisted).toMatchObject({ status: 'terminal', sequence: row.sequence, digest: row.digest });
      expect((await f.store.getQueueReceipt(scope, row.sequence))?.opId).toBe(row.opId);
    }
    for (const node of f.nodes) expect(f.api.node(node.id)).toEqual(node);
    const reads = f.reads();
    expect(reads.guardCalls).toBeGreaterThanOrEqual(f.original.length * 2);
    // Boundary reads may scale with the few selected/private roots, never
    // with the entire synchronized library once for each operation/phase.
    expect(reads.guardMappingRows, JSON.stringify(reads)).toBe(0);
    expect(reads.pointReads).toBeGreaterThanOrEqual(reads.guardCalls);
    expect(reads.pointReads).toBeLessThanOrEqual(reads.guardCalls * 16);
  } finally { f.store.close(); }
}, 15_000);

test('a lost first-sync batch retries its original singleton attempt bytes through fresh boundary checks', async () => {
  const f = await fixture(0, true);
  try {
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('unknown');
    const before = await f.store.listQueue(scope), calls = f.reads().guardCalls;
    expect(before.every(row => row.status === 'unknown' && row.attempt?.body)).toBe(true);
    const initial = JSON.parse(f.sent[0]!).operations;
    for (const [index, row] of before.entries()) expect(JSON.parse(row.attempt!.body).operations).toEqual([initial[index]]);
    f.advance(); f.store.close();
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('terminal');
    expect(f.sent.slice(1)).toEqual(before.map(row => row.attempt!.body));
    expect(f.reads().guardCalls).toBeGreaterThan(calls);
    for (const row of before) {
      const after = await f.store.getQueueByOpId(scope, row.opId);
      expect(after).toMatchObject({ status: 'terminal', digest: row.digest, sequence: row.sequence });
      expect((await f.store.getQueueReceipt(scope, row.sequence))?.operationDigest).toBe(row.digest);
    }
  } finally { f.store.close(); }
});

test('moving a private canonical mapping to a new native ancestor during dispatch blocks the batch', async () => {
  const f = await fixture(0);
  try {
    const privateMapping = (await f.store.getMappingByNativeId(scope, 'root-private'))!;
    expect(privateMapping).toBeDefined();
    await createOutboundPushWorker({ ...f.options, dispatch: async (_row, send) => {
      f.api.put(folder('new-private-ancestor', '0', 3, 'New private ancestor'));
      f.api.put({ ...f.api.node('root-selected'), parentId: 'new-private-ancestor' });
      await f.store.deleteMapping(scope, privateMapping.nativeId);
      const { scopeKey: _key, ...rest } = privateMapping;
      await f.store.putMapping(scope, { ...rest, nativeId: 'new-private-ancestor', rootNativeId: 'new-private-ancestor' });
      return send();
    } }).drain();
    expect(f.sent).toEqual([]);
    for (const row of f.original) {
      const after = await f.store.getQueueByOpId(scope, row.opId);
      expect(after).toMatchObject({ sequence: row.sequence, digest: row.digest });
      expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
    }
    for (const node of f.nodes) expect(f.api.node(node.id)).toEqual(node);
  } finally { f.store.close(); }
});
