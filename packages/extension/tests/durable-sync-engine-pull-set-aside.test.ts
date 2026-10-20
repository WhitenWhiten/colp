import { runSyncResilienceConformance } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { ack, json, pullEventsPage, scope, setup } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const create = (sequence: number, parentId: string) => pullFixtures.createEvent({ kind: 'Bookmark', sequence,
  collectionId: scope.collectionId, parentId });

describe('P1 a Pull event this browser cannot apply is one item, and the Ack says so', () => {
  test('the rest of the page applies, the cursor acks, and the Ack carries the warning', async () => {
    const fixture = await setup({ useRealPullApplier: true, confirmedMount: true });
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
    const report = await runSyncResilienceConformance({ async runScenario() {
      return { events: await Promise.all([11, 12, 13].map(async n => ({ nodeId: `node-created-${n}`,
        state: await fixture.store.getMappingByColpId(scope, `node-created-${n}`) ? 'applied' : 'not_applied' }))),
      issues: await fixture.store.listPullIssues(scope), cursor: exported.cursor?.cursor,
      ackedCursor: exported.engine.lastAckedCursor, warnings: body.warnings };
    } }, { cases: ['SYNC-0033'] });
    assert.equal(report.summary.pass, 1); assert.equal(report.summary.fail, 0);
    fixture.store.close();
  });
});


test('SYNC-0034: a corrupt effect cannot become an item or mutate the browser', async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    const before = [...f.chromeNodes.values()].map(node => ({ ...node }));
    const previous = (await f.store.getScope(scope))!.checkpoint!.cursor;
    const bad: any = create(11, 'root-old');
    bad.effect.effectDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    f.pullResponses.push(json(200, pullEventsPage([bad], 'cursor-1')));
    await f.engine.wake('manual');
    const report = await runSyncResilienceConformance({ async runScenario() {
      return { failureCode: (await f.store.getEngineState(scope))?.lastError,
        cursorBefore: previous, cursorAfter: (await f.store.getCursor(scope))?.cursor ?? previous,
        nativeBefore: before, nativeAfter: [...f.chromeNodes.values()], setAside: await f.store.listPullIssues(scope) };
    } }, { cases: ['SYNC-0034'] });
    assert.equal(report.summary.pass, 1, JSON.stringify(report));
  } finally { f.store.close(); }
});
