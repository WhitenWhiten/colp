import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { mayUnfreezeForCompletedBootstrapAck } from '../src/bootstrap-ack-unfreeze.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { reopenT02, setupT02, t02Scope } from './srg-t02-native-harness.js';
import { ack, scope as engineScope, seedLegacySpc2Bootstrap, setup as engineSetup } from './durable-sync-engine-harness.js';

describe('T-02 native create executor (SRG-05 / C-02 / C-03)', () => {
  test('N-01: after return nativeId is persisted, any restart yields exactly one native + one mapping', async () => {
    const fixture = await setupT02('after_evidence_before_mapping');
    await fixture.applier.stage(fixture.page([fixture.createEvent()]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const evidenceId = (await fixture.store.exportScope(t02Scope)).intents
      .map((intent) => intent.apiResultEvidence?.nativeId).find((id) => typeof id === 'string');
    assert.equal(typeof evidenceId, 'string');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 1);
    fixture.disableCrash();
    const resumed = await reopenT02(fixture);
    await resumed.applier.resume();
    const created = resumed.api.all().filter((node) => node.id.startsWith('created-'));
    assert.equal(created.length, 1);
    assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 1);
    const mapped = await resumed.store.getMappingByColpId(t02Scope, 'node-created-1');
    assert.equal(mapped?.nativeId, evidenceId);
    assert.equal((await resumed.store.exportScope(t02Scope)).cursor?.cursor, 'cursor-next');
  });

  test('N-02: Chrome create already happened, evidence not persisted, interrupt → no second create', async () => {
    const fixture = await setupT02('after_create_before_evidence');
    await fixture.applier.stage(fixture.page([fixture.createEvent()]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 1);
    const evidenceId = (await fixture.store.exportScope(t02Scope)).intents
      .map((intent) => intent.apiResultEvidence?.nativeId).find((id) => typeof id === 'string');
    assert.equal(evidenceId, undefined);
    fixture.disableCrash();
    const resumed = await reopenT02(fixture);
    await resumed.applier.resume().catch((error: unknown) => {
      if (!(error instanceof Error) || !/native_result_unknown|recovery_required/u.test(error.message)) throw error;
    });
    assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 1);
    assert.equal(resumed.api.all().filter((node) => node.id.startsWith('created-')).length, 1);
    const intent = (await resumed.store.exportScope(t02Scope)).intents[0];
    assert.equal(intent?.nativeResult, 'result_unknown');
    assert.notEqual((await resumed.store.exportScope(t02Scope)).cursor?.cursor, 'cursor-next');
  });

  test('N-03: the unique newcomer is a user-created bookmark and must not be claimed', async () => {
    const fixture = await setupT02('after_create_before_evidence');
    await fixture.applier.stage(fixture.page([fixture.createEvent()]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const pullNative = fixture.api.all().find((node) => node.id.startsWith('created-'))!;
    await fixture.api.remove(pullNative.id);
    fixture.api.seed({
      id: 'user-bookmark', parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/',
    });
    fixture.disableCrash();
    const resumed = await reopenT02(fixture);
    await resumed.applier.resume().catch((error: unknown) => {
      if (!(error instanceof Error) || !/native_result_unknown|recovery_required/u.test(error.message)) throw error;
    });
    assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 1);
    assert.equal((await resumed.store.getMappingByNativeId(t02Scope, 'user-bookmark')), null);
    assert.notEqual((await resumed.store.getMappingByColpId(t02Scope, 'node-created-1'))?.nativeId, 'user-bookmark');
  });

  test('N-04: user renamed/moved/deleted the first create so newcomers=0 → no auto recreate', async () => {
    for (const mutate of ['rename', 'move', 'delete'] as const) {
      const fixture = await setupT02('after_create_before_evidence');
      fixture.api.seed({ id: 'other-root', title: 'Other' });
      await fixture.applier.stage(fixture.page([fixture.createEvent()]));
      await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
      const created = fixture.api.all().find((node) => node.id.startsWith('created-'))!;
      if (mutate === 'rename') await fixture.api.update(created.id, { title: 'User renamed' });
      if (mutate === 'move') await fixture.api.move(created.id, { parentId: 'other-root' });
      if (mutate === 'delete') await fixture.api.remove(created.id);
      fixture.disableCrash();
      const resumed = await reopenT02(fixture);
      await resumed.applier.resume().catch((error: unknown) => {
        if (!(error instanceof Error) || !/native_result_unknown|recovery_required/u.test(error.message)) throw error;
      });
      assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 1, mutate);
      const stillMatching = resumed.api.all().filter((node) => node.title === 'Remote' && node.url === 'https://example.test/'
        && node.parentId === 'native-root');
      assert.equal(stillMatching.length, 0, mutate);
    }
  });

  test('N-05: two canonical Nodes with identical title/URL both succeed with distinct intents/natives', async () => {
    const fixture = await setupT02();
    const first = fixture.createEvent('Bookmark', 1);
    const second = pullFixtures.createEvent({
      kind: 'Bookmark', sequence: 2, collectionId: t02Scope.collectionId, parentId: 'root-colp',
    });
    await fixture.applier.stage(fixture.page([first, second]));
    await fixture.applier.resume();
    const created = fixture.api.all().filter((node) => node.id.startsWith('created-'));
    assert.equal(created.length, 2);
    assert.equal(new Set(created.map((node) => node.id)).size, 2);
    const mapA = await fixture.store.getMappingByColpId(t02Scope, 'node-created-1');
    const mapB = await fixture.store.getMappingByColpId(t02Scope, 'node-created-2');
    assert.ok(mapA?.nativeId && mapB?.nativeId);
    assert.notEqual(mapA.nativeId, mapB.nativeId);
    const intents = (await fixture.store.exportScope(t02Scope)).intents;
    assert.notEqual(intents[0]?.colpId, intents[1]?.colpId);
  });

  test('N-06: pending Pull page + old bootstrap Ack does not loop-unfreeze', async () => {
    assert.equal(mayUnfreezeForCompletedBootstrapAck({
      pendingIncompletePull: true, nativeResultUnknown: false,
    }), false);
    assert.equal(mayUnfreezeForCompletedBootstrapAck({
      pendingIncompletePull: false, nativeResultUnknown: true,
    }), false);
    assert.equal(mayUnfreezeForCompletedBootstrapAck({
      pendingIncompletePull: false, nativeResultUnknown: false,
    }), true);

    const fixture = await engineSetup({ snapshotRequired: false });
    await seedLegacySpc2Bootstrap(fixture.store);
    await fixture.store.completeAckIntent(engineScope, 'legacy-spc2-intent', ack('bootstrap-cursor'));
    const cursor = (await fixture.store.getCursor(engineScope))?.cursor
      ?? (await fixture.store.getScope(engineScope))?.checkpoint?.cursor ?? 'cursor-0';
    await fixture.store.stagePullPage(engineScope, {
      pageId: 'page-pending-t02', previousCursor: cursor, nextCursor: 'cursor-pending',
      collectionRevision: 'revision-pending', pageDigest: 'sha256:pending-t02',
      events: [{
        eventId: 'pending-t02-e1', cursor: 'cursor-pending', operationId: 'op-pending-t02',
        effectId: 'fx-pending-t02', effectDigest: 'sha256:fx', operationDigest: 'sha256:op',
        kind: 'node_created', payload: {},
      }],
    });
    await fixture.store.transitionEngine(engineScope, {
      phase: 'recovery', updatedAt: fixture.clock.now, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-engine',
    });
    await fixture.engine.wake('manual');
    const state = await fixture.store.getEngineState(engineScope);
    assert.equal(state?.recoveryFrozen, true);
  });

  test('N-07: a create under a missing folder is set aside while the rest applies; mid-flight revoke keeps shadow', async () => {
    const missing = await setupT02();
    const good = missing.createEvent('Bookmark', 1);
    const bad = pullFixtures.createEvent({
      kind: 'Bookmark', sequence: 2, collectionId: t02Scope.collectionId, parentId: 'missing-folder',
    });
    await missing.applier.stage(missing.page([good, bad])); await missing.applier.resume();
    assert.equal(missing.api.calls.filter((call) => call.kind === 'create').length, 1);
    assert.deepEqual((await missing.store.listPullIssues(t02Scope)).map((issue) => issue.code), ['parent_mapping_missing']);

    const mid = await setupT02();
    let creates = 0;
    const original = mid.api.create.bind(mid.api);
    mid.api.create = async (input) => {
      creates += 1;
      if (creates > 1) throw new Error('permission_revoked');
      return original(input);
    };
    const first = mid.createEvent('Bookmark', 1);
    const second = pullFixtures.createEvent({
      kind: 'Bookmark', sequence: 2, collectionId: t02Scope.collectionId, parentId: 'root-colp',
    });
    await mid.applier.stage(mid.page([first, second]));
    await assert.rejects(() => mid.applier.resume(), /permission_revoked|native_result_unknown|failed/);
    const shadow = await mid.store.getPullEvent(t02Scope, `${first.cursor}:${first.operation!.opId}`);
    assert.ok(shadow?.state === 'authority_committed' || shadow?.state === 'native_event_observed'
      || shadow?.state === 'browser_call_started');
    assert.notEqual((await mid.store.exportScope(t02Scope)).cursor?.cursor, 'cursor-next');
    assert.notEqual((await mid.store.exportScope(t02Scope)).pullPages[0]?.state, 'page_complete');
  });

  test('N-08: confirmation API resolves unknown, then a new local edit still converges', async () => {
    const fixture = await setupT02('after_create_before_evidence');
    await fixture.applier.stage(fixture.page([fixture.createEvent()]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    fixture.disableCrash();
    const resumed = await reopenT02(fixture);
    await resumed.applier.resume().catch((error: unknown) => {
      if (!(error instanceof Error) || !/native_result_unknown|recovery_required/u.test(error.message)) throw error;
    });
    const waits = await projectNativeWaits(resumed.store, t02Scope);
    assert.ok(waits.length > 0);
    const wait = waits[0]!;
    const created = resumed.api.all().find((node) => node.id.startsWith('created-'))!;
    const stale = await confirmNativeWait({
      scope: t02Scope, store: resumed.store, api: resumed.api, waitRef: 'nwr:stale', intentId: wait.intentId,
      generation: t02Scope.generation, action: 'bind', nativeId: created.id,
    });
    assert.equal(stale.ok, false);
    if (stale.ok === false) assert.equal(stale.code, 'stale_ref');
    const bound = await confirmNativeWait({
      scope: t02Scope, store: resumed.store, api: resumed.api, waitRef: wait.waitRef, intentId: wait.intentId,
      generation: t02Scope.generation, action: 'bind', nativeId: created.id,
    });
    assert.equal(bound.ok, true);
    if (bound.ok) assert.equal(bound.result, 'bound');
    const afterBind = (await resumed.store.exportScope(t02Scope)).intents
      .find((intent) => intent.intentId === wait.intentId);
    assert.equal(afterBind?.nativeResult, 'applied_with_evidence');
    assert.equal(afterBind?.nativeResultConfirmation?.kind, 'candidate_event');
    assert.equal((await projectNativeWaits(resumed.store, t02Scope)).some((row) => row.intentId === wait.intentId), false);
    const duplicate = await confirmNativeWait({
      scope: t02Scope, store: resumed.store, api: resumed.api, waitRef: wait.waitRef, intentId: wait.intentId,
      generation: t02Scope.generation, action: 'bind', nativeId: created.id,
    });
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.result, 'duplicate');
    assert.equal((await resumed.store.getMappingByColpId(t02Scope, 'node-created-1'))?.nativeId, created.id);
    await resumed.applier.resume();
    assert.equal((await resumed.store.exportScope(t02Scope)).cursor?.cursor, 'cursor-next');
    assert.equal((await resumed.store.getMappingByColpId(t02Scope, 'node-created-1'))?.nativeId, created.id);
    resumed.api.seed({
      id: 'user-edit', parentId: 'native-root', index: 1, title: 'Local edit', url: 'https://example.test/local',
    });
    const queue = createBookmarkEventQueue({
      scope: t02Scope, store: resumed.store, api: resumed.api as unknown as BookmarkEventApi, autoFlush: false,
      uuid: (() => { let n = 0; return () => `t02-n08-${++n}`; })(),
    });
    const staged = await queue.created('user-edit', {
      id: 'user-edit', parentId: 'native-root', index: 1, title: 'Local edit', url: 'https://example.test/local',
    });
    assert.equal(staged.outcome, 'staged');
    await queue.flush();
    const queued = await resumed.store.listQueue(t02Scope);
    assert.ok(queued.some((row) => row.payload.type === 'create_node'));
    assert.equal((await resumed.store.getMappingByColpId(t02Scope, 'node-created-1'))?.nativeId, created.id);
    assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 1);
  });
});
