import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { STALLED_UPLOAD_ATTEMPTS, stalledUploadHead } from '../src/engine-public-stability.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { installOutboundPushIndexedDb, json, problem, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F1: a plain browser create (star button, drag) carries the colp id of a
 * neighbour. When another device deletes or moves that neighbour first, the
 * server answers 409 position_context_stale for ever. The retried create used
 * to be sent byte-identically for ever: the row stayed lane head, the cleared
 * attempt hid it from stalledUploadHead, and no exit was offered.
 */
async function plainCreate() {
  const fixture = await setup({ createPlacement: 'bottom' });
  // No saved-placement intent: the create came from the star button or a drag.
  const db = await fixture.store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('bookmark_events', 'readwrite');
    tx.objectStore('bookmark_events').openCursor().onsuccess = (event: any) => {
      const cursor = event.target.result; if (!cursor) return;
      const value = cursor.value; delete value.details.context; cursor.update(value); cursor.continue();
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  return fixture;
}

interface Sent { readonly afterId?: string; readonly beforeId?: string; readonly key: string; readonly body: string }

function serverModel(liveSiblings: ReadonlySet<string>, sent: Sent[]) {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const operation = body.operations[0];
    const { afterId, beforeId } = operation.payload as { afterId?: string; beforeId?: string };
    sent.push({ ...(afterId === undefined ? {} : { afterId }), ...(beforeId === undefined ? {} : { beforeId }),
      key: new Headers(init?.headers).get('idempotency-key') ?? '', body: String(init?.body) });
    if ((afterId !== undefined && !liveSiblings.has(afterId)) || (beforeId !== undefined && !liveSiblings.has(beforeId))) {
      return problem(409, 'position_context_stale', { retryable: true });
    }
    return json(200, { batchId: body.batchId, results: [{ opId: operation.opId, sequence: operation.sequence,
      status: 'applied', targetId: 'node-created', revision: 'node-r1', cursor: 'cursor-1', warnings: [] }],
    serverCursor: 'cursor-1' });
  };
}

async function drainUntilSettled(fixture: Awaited<ReturnType<typeof plainCreate>>,
  worker: ReturnType<typeof createOutboundPushWorker>, limit: number) {
  const outcomes: string[] = [];
  for (let drain = 0; drain < limit; drain += 1) {
    const outcome = await worker.drain();
    outcomes.push(outcome.outcome);
    if (outcome.outcome === 'terminal') break;
    const row = (await fixture.store.listQueue(scope))[0]!;
    fixture.clock.now = Math.max(fixture.clock.now, row.retry.notBefore) + 1;
  }
  return outcomes;
}

describe('A-F1 stale sibling anchor on a plain browser create', () => {
  test('the retried create drops an anchor that is no longer live under its parent and uploads', async () => {
    const fixture = await plainCreate();
    // The neighbour was deleted on another device and the Pull already removed its mapping.
    await fixture.store.deleteMapping(scope, 'native-anchor-old');
    const sent: Sent[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => 'continue',
      fetch: serverModel(new Set(), sent) });
    try {
      const outcomes = await drainUntilSettled(fixture, worker, 6);
      assert.equal(outcomes.at(-1), 'terminal', `settled, not replayed for ever: ${outcomes.join(',')}`);
      assert.ok(sent.length <= 3, `${sent.length} sends`);
      assert.equal(sent[0]!.afterId, 'anchor-old', 'the first send still carries the captured anchor');
      assert.equal(sent.at(-1)!.afterId, undefined, 'the retried create no longer names the dead sibling');
      assert.notEqual(sent.at(-1)!.key, sent[0]!.key, 'changed bytes use a new idempotency identity');
      const row = (await fixture.store.listQueue(scope))[0]!;
      assert.equal(row.status, 'terminal');
      assert.equal(row.opId, 'op-push-1', 'the same operation and sequence are re-authored, not replaced');
    } finally { fixture.store.close(); }
  });

  test('a stale answer the local mirror cannot explain re-authors the create without anchors after repeated answers', async () => {
    const fixture = await plainCreate();
    // The mirror still lists the neighbour under the parent; the server disagrees.
    const sent: Sent[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => 'continue',
      fetch: serverModel(new Set(), sent) });
    try {
      const outcomes = await drainUntilSettled(fixture, worker, 12);
      assert.equal(outcomes.at(-1), 'terminal', outcomes.join(','));
      const anchored = sent.filter((entry) => entry.afterId !== undefined);
      assert.ok(anchored.length >= 2 && anchored.length <= 6, `${anchored.length} anchored sends before the fallback`);
      assert.equal(sent.at(-1)!.afterId, undefined);
      assert.equal(new Set(anchored.map((entry) => entry.key)).size, 1,
        'identical bytes keep their idempotency key until the create is deliberately re-authored');
    } finally { fixture.store.close(); }
  });

  test('a sent create with an unresolved attempt is never re-authored', async () => {
    const fixture = await plainCreate();
    const bodies: string[] = []; const keys: string[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => 'continue',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body)); keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
        throw new TypeError('lost response');
      } });
    try {
      for (let drain = 0; drain < 10; drain += 1) {
        assert.equal((await worker.drain()).outcome, 'unknown');
        const row = (await fixture.store.listQueue(scope))[0]!;
        assert.ok(row.attempt, 'the sent create keeps its attempt');
        fixture.clock.now = Math.max(fixture.clock.now, row.retry.notBefore) + 1;
      }
      assert.equal(new Set(bodies).size, 1, 'the bytes of a possibly executed create never change');
      assert.equal(new Set(keys).size, 1);
      assert.equal(JSON.parse(bodies[0]!).operations[0].payload.afterId, 'anchor-old');
    } finally { fixture.store.close(); }
  });

  test('an attempt-less create the server keeps refusing as stale is a visible stalled upload', async () => {
    const fixture = await plainCreate();
    // Even a create without anchors can be refused as stale (position rebalance escalation).
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => 'continue',
      fetch: async () => problem(409, 'position_context_stale', { retryable: true }) });
    try {
      for (let drain = 0; drain < STALLED_UPLOAD_ATTEMPTS + 2; drain += 1) {
        await worker.drain();
        const row = (await fixture.store.listQueue(scope))[0]!;
        fixture.clock.now = Math.max(fixture.clock.now, row.retry.notBefore) + 1;
      }
      const rows = await fixture.store.listQueue(scope);
      assert.equal(rows[0]!.attempt, undefined, 'the refusal cleared the attempt');
      assert.equal(stalledUploadHead(rows)?.code, 'position_context_stale');
      const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: fixture.store });
      assert.equal(attention.ok && attention.attention.issueCount, 1);
    } finally { fixture.store.close(); }
  });

  test('stalledUploadHead counts attempt-less placement refusals only after the stalled threshold', () => {
    const row = (overrides: Partial<QueueOperation>): QueueOperation => ({ scopeKey: 's', sequence: 1, opId: 'op', batchId: 'b',
      idempotencyKey: 'k', digest: 'd', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'r', status: 'unknown', retry: { attempt: STALLED_UPLOAD_ATTEMPTS, notBefore: 0 },
      recovery: { code: 'position_context_stale' }, payload: { type: 'create_node' }, ...overrides } as QueueOperation);
    assert.equal(stalledUploadHead([row({})])?.code, 'position_context_stale');
    assert.equal(stalledUploadHead([row({ recovery: { code: 'revision_conflict' } })])?.code, 'revision_conflict');
    assert.equal(stalledUploadHead([row({ retry: { attempt: STALLED_UPLOAD_ATTEMPTS - 1, notBefore: 0 } })]), undefined);
    // Other transient answers stay about the browser, not the change.
    assert.equal(stalledUploadHead([row({ recovery: { code: 'server_unavailable' } })]), undefined);
    assert.equal(stalledUploadHead([row({ recovery: { code: 'push_network_failed' } })]), undefined);
  });
});
