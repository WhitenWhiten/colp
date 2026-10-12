/**
 * Owner: KNS-09 (Release). Formal ID: FR-ROLLBACK-DRAIN.
 * Run: npx vitest run tests/kns-09-rollback-drain.test.ts
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { kns09Paused, setKns09MutationSwitchesForTests } from '../src/kns-09-release.js';
import { confirmAddRange } from '../src/scope-commands.js';
import { installOutboundPushIndexedDb, json, operation, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

describe('KNS-09 rollback drain', () => {
  test('FR-ROLLBACK-DRAIN: disconnect then drain reuses one HTTP body and never silent-deletes', async () => {
    const fixture = await setup();
    setKns09MutationSwitchesForTests({ coordinator: false, ui: false });
    try {
    assert.equal(await kns09Paused('coordinator'), true);
    const paused = await confirmAddRange(fixture.store, scope, {
      previewId: 'preview-roll', confirmationId: 'confirm-roll', treeDigest: 'sha256:tree',
      localFacts: [],
    });
    assert.equal(paused.ok, false);
    if (!paused.ok) assert.equal(paused.error, 'sync_paused');

    const requests: string[] = [];
    let attempt = 0;
    const worker = createOutboundPushWorker({
      ...fixture.options,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        attempt += 1;
        if (attempt === 1) throw new TypeError('network_disconnected');
        return json(200, {
          batchId: fixture.queued.batchId,
          results: [{
            opId: fixture.queued.opId, sequence: 1, status: 'applied',
            targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [],
          }],
          serverCursor: 'cursor-1',
        });
      },
    });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const unknown = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(unknown.status, 'unknown');
    fixture.clock.now = unknown.retry.notBefore;
    assert.equal((await createOutboundPushWorker({
      ...fixture.options,
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return json(200, {
          batchId: fixture.queued.batchId,
          results: [{
            opId: fixture.queued.opId, sequence: 1, status: 'applied',
            targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [],
          }],
          serverCursor: 'cursor-1',
        });
      },
    }).drain()).outcome, 'terminal');
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal(JSON.parse(requests[0]!).operations[0].opId, fixture.queued.opId);
    assert.equal(JSON.parse(requests[0]!).operations[0].sequence, 1);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.queue.length, 1);
    assert.equal(exported.queue[0]?.status, 'terminal');
    assert.equal(exported.queue.filter((row) => row.payload.type === 'delete_node').length, 0);
    assert.equal(exported.receipts.length, 1);
    assert.equal(operation.type, 'create_node');
    } finally { setKns09MutationSwitchesForTests(); }
  });
});
