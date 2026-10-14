import { describe, expect, it } from 'vitest';
import { validateAutomation, type LocalReceiptInput } from '@know-n/colp/automation';
import type { AutomationStateArea } from '../src/automation/bundle-store.js';
import type { DeviceResult } from '../src/automation/device-client.js';
import { createReceiptStore, newPlacementReceipt, serializeReceipt, syncReceipts, type CanonicalCreate, type PlacementReceipt,
  type ReceiptEvidence, type ReceiptSyncContext } from '../src/automation/receipt-sync.js';
import { syncReceiptEvidence } from '../src/automation/receipt-evidence.js';
import { COLLECTION_ID, NOW, folderRef } from './automation-fixture.js';

function memoryArea(): AutomationStateArea {
  const values = new Map<string, unknown>();
  return { async get(key) { return structuredClone(values.get(key)); }, async set(key, value) { values.set(key, structuredClone(value)); } };
}
const OWNER = '["https://colp.example","owner-1"]';
const NATIVE_ID = 'native-4711', NATIVE_FOLDER = 'native-folder-88';
/* Digests computed with the server's own placementInputDigest/placementResultDigest
   (packages/server accept-intake-receipt.ts) for these exact inputs. */
const SERVER_INPUT_DIGEST = 'c90a6d6d657b4064948baf959e45a8ee88dff2b0a05fbdf749affcd970286f2f';
const SERVER_RESULT_DIGEST = '29891fc56f4dc27a5b27b5da18d42542d2d8010f17dd22d450584928d90bc3f7';
const created: CanonicalCreate = { nodeId: 'node-paper', operationId: 'op-create', parentNodeId: 'academic',
  url: 'https://arxiv.org/abs/2401.0001', title: 'Attention is all you need', tags: [] };

function receipt(patch: Partial<Parameters<typeof newPlacementReceipt>[0]> = {}, at = NOW): PlacementReceipt {
  return newPlacementReceipt({ ownerKey: OWNER, collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2, path: 'preSave',
    rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '3', bindingRevision: '2', bundleRevision: '41' },
    destination: folderRef('academic'), destinationTitle: 'Academic', satisfies: ['classify.root'],
    page: { title: 'Attention is all you need', url: 'https://arxiv.org/abs/2401.0001' },
    native: { nativeId: NATIVE_ID, destinationNativeId: NATIVE_FOLDER }, ...patch }, at, '6c5b0f8e-7c9a-4f3e-9d51-2a0b1c3d4e5f');
}

function context(evidence: Partial<ReceiptEvidence>, answers: DeviceResult[], patch: Partial<ReceiptSyncContext> = {}) {
  const posted: LocalReceiptInput[] = [];
  const value: ReceiptSyncContext = { ownerKey: OWNER, collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2,
    deviceId: 'device-server-1', replicaGeneration: 7, now: NOW,
    evidence: { create: async () => null, move: async () => null, ...evidence },
    post: async (input) => { posted.push(input); return answers.shift() ?? { ok: false, problem: 'offline', status: 0 }; }, ...patch };
  return { value, posted };
}
const answer = (state: string, satisfied: string[] = []): DeviceResult => ({ ok: true, status: 202,
  body: { receiptId: 'srv-1', state, satisfiedTaskTypes: satisfied, diagnostics: [{ code: state, severity: 'info', location: '/', message: state }] } });

describe('canonical-only receipt serialization', () => {
  it('sends canonical identity and pinned revisions, with the server’s own digests', () => {
    const input = serializeReceipt({ ...receipt(), canonical: { nodeId: 'node-paper', operationId: 'op-create' } }, created,
      { deviceId: 'device-server-1', replicaGeneration: 7 });
    expect(validateAutomation('LocalReceiptInput', input).valid).toBe(true);
    expect(input).toEqual({ deviceId: 'device-server-1', replicaGeneration: 7, localReceiptId: '6c5b0f8e-7c9a-4f3e-9d51-2a0b1c3d4e5f',
      operationId: 'op-create', ruleId: 'rule-arxiv', ruleRevision: '3', bindingRevision: '2', bundleRevision: '41',
      inputDigest: SERVER_INPUT_DIGEST, satisfiedTaskTypes: ['classify.root'],
      committedNode: { serverUuid: 'server-fixture', collectionId: COLLECTION_ID, nodeId: 'node-paper' }, resultDigests: [SERVER_RESULT_DIGEST] });
  });

  it('never serializes a native id or the native observation', () => {
    const observed = { ...receipt({ path: 'observed', beforeFolder: folderRef('other-bookmarks'),
      native: { nativeId: NATIVE_ID, destinationNativeId: NATIVE_FOLDER, movedAt: NOW } }),
    canonical: { nodeId: 'node-paper', operationId: 'op-create', placementOperationId: 'op-move' } };
    const text = JSON.stringify(serializeReceipt(observed, { ...created, parentNodeId: 'other-bookmarks' }, { deviceId: 'device-server-1', replicaGeneration: 7 }));
    expect(text).not.toContain(NATIVE_ID);
    expect(text).not.toContain(NATIVE_FOLDER);
    expect(text).not.toMatch(/native/iu);
    expect(JSON.parse(text)).toMatchObject({ placementOperationId: 'op-move', beforeFolder: folderRef('other-bookmarks') });
  });

  it('claims only the rule’s own root declaration, never enrichment', () => {
    const input = serializeReceipt({ ...receipt({ satisfies: [] }), canonical: { nodeId: 'node-paper', operationId: 'op-create' } }, created,
      { deviceId: 'd', replicaGeneration: 1 });
    expect(input.satisfiedTaskTypes).toEqual([]);
    expect(() => serializeReceipt(receipt(), created, { deviceId: 'd', replicaGeneration: 1 })).toThrow('receipt_canonical_missing');
  });
});

describe('receipt delivery', () => {
  it('receipt before Sync: waits locally, then joins once the canonical create exists', async () => {
    const store = createReceiptStore(memoryArea());
    await store.add(receipt(), NOW);
    const first = context({}, []);
    expect(await syncReceipts(store, first.value)).toEqual({ sent: 0, pending: 1 });
    expect(first.posted).toEqual([]);
    const [waiting] = await store.list();
    expect(waiting).toMatchObject({ state: 'local', attempts: 1 });
    expect(waiting!.nextAttemptAt).toBeGreaterThan(NOW);
    // The server has not ingested the Sync operation yet: it answers waitingForSync and is asked again later.
    const later = context({ create: async () => created }, [answer('waitingForSync'), answer('accepted', ['classify.root'])], { now: waiting!.nextAttemptAt });
    await syncReceipts(store, later.value);
    expect((await store.list())[0]).toMatchObject({ state: 'waitingForSync', canonical: { nodeId: 'node-paper', operationId: 'op-create' } });
    await syncReceipts(store, { ...later.value, now: (await store.list())[0]!.nextAttemptAt });
    expect((await store.list())[0]).toMatchObject({ state: 'accepted' });
    expect(later.posted).toHaveLength(2);
    expect(later.posted[0]!.localReceiptId).toBe(later.posted[1]!.localReceiptId);
    // Settled receipts are not sent again.
    await syncReceipts(store, { ...later.value, now: NOW + 86_400_000 });
    expect(later.posted).toHaveLength(2);
  });

  it('Sync before receipt: the first attempt is accepted', async () => {
    const store = createReceiptStore(memoryArea());
    await store.add(receipt(), NOW);
    const run = context({ create: async () => created }, [answer('accepted', ['classify.root'])]);
    expect(await syncReceipts(store, run.value)).toEqual({ sent: 1, pending: 0 });
    expect((await store.list())[0]).toMatchObject({ state: 'accepted' });
  });

  it('an observed correction waits for both operations, unless the create already landed in the destination', async () => {
    const store = createReceiptStore(memoryArea());
    const observed = receipt({ path: 'observed', beforeFolder: folderRef('other-bookmarks'),
      native: { nativeId: NATIVE_ID, destinationNativeId: NATIVE_FOLDER, movedAt: NOW } });
    await store.add(observed, NOW);
    const atRoot = { ...created, parentNodeId: 'other-bookmarks' };
    const noMove = context({ create: async () => atRoot }, []);
    await syncReceipts(store, noMove.value);
    expect(noMove.posted).toEqual([]);
    const withMove = context({ create: async () => atRoot, move: async (_native, destination) => destination === NATIVE_FOLDER ? 'op-move' : null },
      [answer('accepted', ['classify.root'])], { now: (await store.list())[0]!.nextAttemptAt });
    await syncReceipts(store, withMove.value);
    expect(withMove.posted[0]).toMatchObject({ operationId: 'op-create', placementOperationId: 'op-move', beforeFolder: folderRef('other-bookmarks') });
    // Folded: the queue created the bookmark in the destination, so there is no move to join.
    const folded = createReceiptStore(memoryArea());
    await folded.add({ ...observed, localReceiptId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }, NOW);
    const direct = context({ create: async () => created }, [answer('accepted')]);
    await syncReceipts(folded, direct.value);
    expect(direct.posted[0]).not.toHaveProperty('placementOperationId');
  });

  it('records review and rejection as the server gave them', async () => {
    for (const state of ['review', 'rejected'] as const) {
      const store = createReceiptStore(memoryArea());
      await store.add(receipt(), NOW);
      await syncReceipts(store, context({ create: async () => created }, [answer(state)]).value);
      expect((await store.list())[0]).toMatchObject({ state });
    }
  });

  it('retries transport failures with backoff and gives up only on contract errors', async () => {
    const store = createReceiptStore(memoryArea());
    await store.add(receipt(), NOW);
    await syncReceipts(store, context({ create: async () => created }, [{ ok: false, problem: 'offline', status: 0 }]).value);
    const first = (await store.list())[0]!;
    expect(first).toMatchObject({ state: 'local', attempts: 1 });
    await syncReceipts(store, context({ create: async () => created }, [{ ok: false, problem: 'rateLimited', status: 503 }], { now: first.nextAttemptAt }).value);
    const second = (await store.list())[0]!;
    expect(second.nextAttemptAt - first.nextAttemptAt).toBeGreaterThan(first.nextAttemptAt - NOW);
    await syncReceipts(store, context({ create: async () => created },
      [{ ok: false, problem: 'server', status: 409, code: 'automation_command_conflict' }], { now: second.nextAttemptAt }).value);
    expect((await store.list())[0]).toMatchObject({ state: 'attention', attention: 'conflict' });
  });

  it('keeps accounts, collections and replica generations apart', async () => {
    const store = createReceiptStore(memoryArea());
    await store.add(receipt({ ownerKey: '["https://colp.example","owner-2"]' }), NOW);
    await store.add({ ...receipt({ collectionId: 'c_other' }), localReceiptId: '11111111-2222-4333-8444-555555555555' }, NOW);
    await store.add({ ...receipt({ generation: 1 }), localReceiptId: '22222222-3333-4444-8555-666666666666' }, NOW);
    const run = context({ create: async () => created }, [answer('accepted')]);
    await syncReceipts(store, run.value);
    expect(run.posted).toEqual([]);
    const byId = new Map((await store.list()).map((item) => [item.localReceiptId, item]));
    expect(byId.get('22222222-3333-4444-8555-666666666666')).toMatchObject({ state: 'attention', attention: 'staleGeneration' });
    expect(byId.get('11111111-2222-4333-8444-555555555555')).toMatchObject({ state: 'local', attempts: 0 });
    expect(byId.get('6c5b0f8e-7c9a-4f3e-9d51-2a0b1c3d4e5f')).toMatchObject({ state: 'local', attempts: 0 });
  });

  it('waits without the server device id instead of inventing one', async () => {
    const store = createReceiptStore(memoryArea());
    await store.add(receipt(), NOW);
    const run = context({ create: async () => created }, [answer('accepted')], { deviceId: null });
    await syncReceipts(store, run.value);
    expect(run.posted).toEqual([]);
    expect((await store.list())[0]).toMatchObject({ state: 'local', canonical: { nodeId: 'node-paper' } });
  });

  it('survives a worker restart: receipts are durable before any network work', async () => {
    const area = memoryArea();
    await createReceiptStore(area).add(receipt(), NOW);
    const restarted = createReceiptStore(area);
    expect(await restarted.list()).toHaveLength(1);
    await syncReceipts(restarted, context({ create: async () => created }, [answer('accepted')]).value);
    expect((await createReceiptStore(area).list())[0]!.state).toBe('accepted');
  });
});

describe('Sync store evidence', () => {
  const scope = { environment: 'development', serverId: 's', serverOrigin: 's', accountId: 'a', browserProfileId: 'b',
    collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2 } as const;
  const queue = new Map<string, { sequence: number; status: string; payload: Record<string, unknown> }>([
    ['op-move-old', { sequence: 3, status: 'terminal', payload: {} }],
    ['op-move', { sequence: 4, status: 'terminal', payload: {} }],
    ['op-move-pending', { sequence: 5, status: 'pending', payload: {} }],
  ]);
  const event = (ordinal: number, opId: string, target: string, at: number) => ({ eventId: `e${ordinal}`, dedupeKey: `d${ordinal}`, scopeKey: 'k',
    ordinal, status: 'processed', opId, kind: 'move', nativeId: NATIVE_ID, occurredAt: new Date(at).toISOString(),
    details: { context: { targetParentNativeId: target } } });
  const store = {
    async getQueueByOpId(_scope: unknown, opId: string) { return queue.get(opId) ?? null; },
    async getQueueReceipt(_scope: unknown, sequence: number) { return { result: { results: [{ status: sequence === 4 ? 'applied' : 'rejected' }] } }; },
    async listBookmarkEventsByNative() {
      return [event(1, 'op-move-old', NATIVE_FOLDER, NOW - 60_000), event(2, 'op-move-pending', NATIVE_FOLDER, NOW + 10), event(3, 'op-move', NATIVE_FOLDER, NOW + 20)];
    },
  } as unknown as Parameters<typeof syncReceiptEvidence>[0];

  it('joins only an applied move into the destination made after the observation', async () => {
    const evidence = syncReceiptEvidence(store, scope);
    expect(await evidence.move(NATIVE_ID, NATIVE_FOLDER, NOW)).toBe('op-move');
    expect(await evidence.move(NATIVE_ID, 'elsewhere', NOW)).toBeNull();
    expect(await evidence.move(NATIVE_ID, NATIVE_FOLDER, NOW + 60_000)).toBeNull();
  });
});
