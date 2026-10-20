import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createAuthorityFence } from '../src/authority-fence.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { plannedCreateNativeId } from '../src/bookmark-event-codec.js';
import { batchBoundaryFixture } from './queued-upload-batch-boundary-harness.js';
import { scope } from './bookmark-event-queue-harness.js';

async function effects(fetcher: typeof fetch, change = async () => undefined) {
  const fence = createAuthorityFence(new MemoryStorageArea()), context = await fence.capture();
  return createSyncEffectAuthority({ scope, context, api: createChromePullBookmarkApi(), fetch: fetcher,
    assertWritable: generation => fence.assertWritable(generation), currentScope: async () => { await change(); return scope; } });
}

for (const count of [1, 3]) test(`a ${count}-operation late refusal proves no dispatch without fabricating a receipt`, async () => {
  const f = await batchBoundaryFixture(count);
  try {
    const transport = await effects(f.options.fetch!, async () => {
      const node = f.nodes.at(-1)!; f.api.put({ ...f.api.node(node.id), parentId: 'root-private' });
    });
    await createOutboundPushWorker({ ...f.options, fetch: transport.fetch }).drain();
    const target = f.original.find(row => plannedCreateNativeId(row.opId) === f.nodes.at(-1)!.id)!;
    const row = await f.store.getQueueByOpId(scope, target.opId);
    expect(row).toMatchObject({ status: 'rejected', recovery: { code: 'bootstrap_upload_excluded' } });
    expect(await f.store.getQueueReceipt(scope, row!.sequence)).toBeNull();
    expect((await f.store.getEngineState(scope))?.recoveryFrozen).not.toBe(true);
    expect(f.sent).toEqual([]);
  } finally { f.store.close(); }
});

for (const count of [1, 3]) test(`a ${count}-operation actual lost response retains exact singleton recovery bytes`, async () => {
  const f = await batchBoundaryFixture(count), headers: (string | null)[] = [];
  let loseResponse = true;
  try {
    const transport = await effects(async (url, init) => {
      headers.push(new Headers(init?.headers).get('Idempotency-Key'));
      const response = await f.options.fetch!(url, init);
      if (loseResponse) throw new TypeError('reply lost after server commit');
      return response;
    });
    expect((await createOutboundPushWorker({ ...f.options, fetch: transport.fetch }).drain()).outcome).toBe('unknown');
    const attempted = await f.store.listQueue(scope, 'unknown'); expect(attempted).toHaveLength(count);
    for (const row of attempted) {
      expect(row.attempt).toBeDefined(); expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
    }
    expect(f.sent).toHaveLength(1); loseResponse = false; f.advance();
    expect((await createOutboundPushWorker({ ...f.options, fetch: transport.fetch }).drain()).outcome).toBe('terminal');
    expect(f.sent.slice(1)).toEqual(attempted.map(row => row.attempt!.body));
    expect(headers.slice(1)).toEqual(attempted.map(row => row.attempt!.idempotencyKey));
    if (count === 1) expect(f.sent[1]).toBe(f.sent[0]);
    for (const row of attempted) expect(await f.store.getQueueReceipt(scope, row.sequence)).toMatchObject({
      kind: 'terminal', opId: row.opId, operationDigest: row.digest,
    });
  } finally { f.store.close(); }
});

test('a late refusal of a genuinely sent unknown attempt keeps the original evidence and stops replay', async () => {
  const f = await batchBoundaryFixture(1);
  try {
    const first = await effects(async (url, init) => {
      await f.options.fetch!(url, init); throw new TypeError('reply lost after server commit');
    });
    await createOutboundPushWorker({ ...f.options, fetch: first.fetch }).drain();
    const original = (await f.store.listQueue(scope, 'unknown'))[0]!; f.advance();
    const retry = await effects(f.options.fetch!, async () => {
      const node = f.nodes[0]!; f.api.put({ ...f.api.node(node.id), parentId: 'root-private' });
    });
    expect((await createOutboundPushWorker({ ...f.options, fetch: retry.fetch }).drain()).outcome).toBe('recovery');
    expect(await f.store.getQueueByOpId(scope, original.opId)).toMatchObject({ status: 'blocked', attempt: original.attempt,
      payload: original.payload, digest: original.digest, sequence: original.sequence, idempotencyKey: original.idempotencyKey });
    expect(await f.store.getQueueReceipt(scope, original.sequence)).toBeNull(); expect(f.sent).toHaveLength(1);
    expect((await f.store.getEngineState(scope))?.lastError).toBe('upload_boundary_changed');
  } finally { f.store.close(); }
});
