import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { ack, json, pullEventsPage, scope, setup } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const create = (sequence: number, parentId: string) => pullFixtures.createEvent({ kind: 'Bookmark', sequence,
  collectionId: scope.collectionId, parentId });

describe('P1 a Pull event this browser cannot apply is one item, and the Ack says so', () => {
  test('the rest of the page applies, the cursor acks, and the Ack carries the warning', async () => {
    const fixture = await setup({ useRealPullApplier: true });
    // The middle create names a folder this browser has never seen.
    fixture.pullResponses.push(json(200, pullEventsPage([create(11, 'root-old'), create(12, 'unknown-folder'),
      create(13, 'root-old')], 'cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-11'));
    assert.equal(await fixture.store.getMappingByColpId(scope, 'node-created-12'), null);
    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-13'));
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
    assert.notEqual(exported.engine.recoveryFrozen, true);
    assert.equal(fixture.ackRequests.length, 1);
    const body = JSON.parse(fixture.ackRequests[0]!.body) as { warnings: Array<Record<string, unknown>> };
    assert.deepEqual(body.warnings, [{ code: 'apply_set_aside', message: 'This browser set this node aside and did not apply it.',
      nodeId: 'node-created-12', path: '/nodes/node-created-12' }]);
  });
});
