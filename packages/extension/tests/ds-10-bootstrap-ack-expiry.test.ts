import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { ack, json, problem, recoverySnapshot, scope, seedLegacySpc2Bootstrap, setup } from './durable-sync-engine-harness.js';

test.each([[404, 'resource_not_found'], [400, 'invalid_cursor_scope'], [410, 'sync_cursor_expired']] as const)(
  'DS-10 invalid bootstrap Ack %s/%s requests fresh Snapshot authority across restart', async (status, code) => {
    const f = await setup({ useStandInProjector: true });
    await f.enqueue('preserved-local-edit');
    await seedLegacySpc2Bootstrap(f.store);
    const before = await f.store.exportScope(scope);
    f.ackResponses.push(problem(status, code, {}));
    await f.engine.wake('startup');
    const refused = await f.store.exportScope(scope);
    assert.equal(refused.ackIntents.length, 0);
    assert.equal(refused.engine.authorityRefreshRequired, true);
    assert.equal(refused.engine.recoveryFrozen, true);
    assert.deepEqual(refused.mappings, before.mappings);
    assert.deepEqual(refused.cursor, before.cursor);
    assert.deepEqual(refused.queue, before.queue);
    f.store.close(); f.clock.now += 1_000;
    f.forcedSessions.push({ sessionId: 'fresh-recovery', state: 'active', snapshotRequired: true, cursor: 'cursor-old' },
      { sessionId: 'fresh-active', state: 'active', snapshotRequired: false, cursor: 'cursor-activated' });
    f.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    f.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await f.reopen().wake('startup');
    const recovered = await f.store.exportScope(scope);
    assert.equal(recovered.engine.recoveryFrozen, false);
    assert.equal(recovered.cursor?.cursor, 'cursor-activated');
    assert.equal(f.ackRequests.filter(request => request.key === 'legacy-spc2-key').length, 1);
  });

test.each([[401, 'authentication_required'], [503, 'service_unavailable'], [404, 'unknown_error']] as const)(
  'DS-10 does not discard bootstrap Ack for %s/%s', async (status, code) => {
    const f = await setup(); await seedLegacySpc2Bootstrap(f.store);
    const before = await f.store.getPendingAckIntent(scope);
    f.ackResponses.push(problem(status, code, {}));
    await f.engine.wake('startup');
    assert.deepEqual(await f.store.getPendingAckIntent(scope), before);
    f.clock.now = (await f.store.getEngineState(scope))!.notBefore;
    f.ackResponses.push(problem(status, code, {}));
    await f.reopen().wake('startup');
    assert.equal(f.ackRequests.length, 2);
    assert.deepEqual(f.ackRequests[1], f.ackRequests[0]);
  });
