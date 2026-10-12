/**
 * N-2: a restore create must not land at index 0 when its anchor read fails.
 * The bad create is only reachable after prepare has already succeeded.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { pullEventCallFact } from '../src/sync-state/recovery-repository.js';
import type { IntentRecord } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

function restore(input: { sequence: number; targetId: string; afterId?: string; title: string }) {
  return pullFixtures.restoreEvent({
    sequence: input.sequence, collectionId: scope.collectionId, targetId: input.targetId,
    parentId: 'root-colp', title: input.title, ...(input.afterId ? { afterId: input.afterId } : {}),
  });
}

async function prepared(crash: string, targetId: string, sequence: number) {
  const fixture = await setup(crash);
  await fixture.applier.stage(fixture.page([restore({
    sequence, targetId, afterId: 'node-child', title: targetId,
  })]));
  await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
  assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), false);
  return fixture;
}

function creates(fixture: Awaited<ReturnType<typeof prepared>>) {
  return fixture.api.calls.filter((call) => call.kind === 'create');
}

describe('N-2 restore anchor placement', () => {
  test('an anchor missing from the start does not create or commit', async () => {
    const fixture = await setup();
    await fixture.api.remove('native-child');
    await fixture.applier.stage(fixture.page([restore({
      sequence: 80, targetId: 'n2-missing', afterId: 'node-child', title: 'n2-missing',
    })]));
    await assert.rejects(() => fixture.applier.resume(), /anchor_mapping_missing/);
    assert.equal(creates(fixture).length, 0);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'n2-missing'), null);
    const events = await fixture.store.listPullEvents(scope);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.state, 'staged');
    assert.equal(pullEventCallFact(events[0]!, undefined), 'not_called');
    assert.equal(await fixture.store.getApplyIntent(scope, `intent:${String(events[0]?.eventId)}`), undefined);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.getScope(scope))?.metadata?.recoveryCode, 'anchor_mapping_missing');
    assert.notEqual((await fixture.store.getScope(scope))?.lifecycle, 'retired');
    await assert.rejects(() => fixture.applier.resume(), /recovery_required/);
    assert.equal(creates(fixture).length, 0);
  });

  test('an anchor lost after prepare does not create at index 0', async () => {
    const fixture = await prepared('after_intent', 'n2-lost', 81);
    await fixture.api.remove('native-child');
    await assert.rejects(() => fixture.applier.resume(), /anchor_mapping_missing/);
    assert.equal(creates(fixture).length, 0);
    assert.equal(fixture.api.all().some((node) => node.title === 'n2-lost'), false);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'n2-lost'), null);
    const events = await fixture.store.listPullEvents(scope);
    const event = events[0]!;
    const intent = await fixture.store.getApplyIntent(scope, `intent:${String(event.eventId)}`) as IntentRecord | null;
    assert.equal(event.state, 'staged');
    assert.equal(intent?.nativeResult, 'not_started');
    assert.equal(intent?.replayState, 'not_started');
    assert.equal(intent?.state, 'staged');
    assert.equal(intent?.apiResultEvidence ?? null, null);
    assert.equal(pullEventCallFact(event, intent ?? undefined), 'not_called');
    const diagnostics = await fixture.store.exportDiagnostics();
    assert.equal(diagnostics.records.some((row) => row.kind === 'restore_create_not_called'
      && row.code === 'anchor_mapping_missing'
      && (row.details as { browserCalled?: boolean } | undefined)?.browserCalled === false), true);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.getScope(scope))?.metadata?.recoveryCode, 'anchor_mapping_missing');
    await assert.rejects(() => fixture.applier.resume(), /recovery_required/);
    assert.equal(creates(fixture).length, 0);
  });

  test('permission revoked after prepare pauses without a create or scope retirement', async () => {
    const fixture = await prepared('after_intent', 'n2-permission', 82);
    fixture.api.denyPermission('native-child');
    await assert.rejects(() => fixture.applier.resume(), /permission_required/);
    assert.equal(creates(fixture).length, 0);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'n2-permission'), null);
    const recorded = await fixture.store.getScope(scope);
    assert.equal(recorded?.lifecycle, 'active');
    assert.equal(recorded?.rootStatus, 'permission_required');
    assert.notEqual(recorded?.lifecycle, 'retired');
    const events = await fixture.store.listPullEvents(scope);
    const event = events[0]!;
    const intent = await fixture.store.getApplyIntent(scope, `intent:${String(event.eventId)}`) as IntentRecord | null;
    assert.equal(event.state, 'staged');
    assert.equal(intent?.nativeResult, 'not_started');
    assert.equal(intent?.apiResultEvidence ?? null, null);
    assert.equal(pullEventCallFact(event, intent ?? undefined), 'not_called');
    await assert.rejects(() => fixture.applier.resume(), /permission/i);
    assert.equal(creates(fixture).length, 0);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
  });

  test('a create failure after the call started is unknown and is not created again', async () => {
    const fixture = await prepared('after_intent', 'n2-create-failed', 83);
    let createsSeen = 0;
    fixture.api.create = async () => {
      createsSeen += 1;
      throw new Error('create_failed');
    };
    await assert.rejects(() => fixture.applier.resume(), /create_failed/);
    assert.equal(createsSeen, 1);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'n2-create-failed'), null);
    assert.equal(fixture.api.all().some((node) => node.title === 'n2-create-failed'), false);
    const events = await fixture.store.listPullEvents(scope);
    const event = events[0]!;
    const intent = await fixture.store.getApplyIntent(scope, `intent:${String(event.eventId)}`) as IntentRecord | null;
    assert.equal(event.state, 'browser_call_started');
    assert.equal(intent?.nativeResult, 'result_unknown');
    assert.notEqual(intent?.nativeResult, 'not_started');
    assert.equal(intent?.replayState, 'awaiting_receipt');
    assert.equal(pullEventCallFact(event, intent ?? undefined), 'unknown');
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    await assert.rejects(() => fixture.applier.resume(), /native_result_unknown/);
    assert.equal(createsSeen, 1);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'n2-create-failed'), null);
  });

  test('a true start position with no anchor still uses index 0', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([restore({
      sequence: 84, targetId: 'n2-start', title: 'n2-start',
    })]));
    await fixture.applier.resume();
    assert.equal(creates(fixture).length, 1);
    assert.equal(fixture.api.lastEvent?.details.index, 0);
    const mapping = await fixture.store.getMappingByColpId(scope, 'n2-start');
    assert.equal((await fixture.api.get(mapping?.nativeId ?? ''))[0]?.index, 0);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
  });

  test('a live anchor is used instead of index 0', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([restore({
      sequence: 85, targetId: 'n2-anchored', afterId: 'node-child', title: 'n2-anchored',
    })]));
    await fixture.applier.resume();
    assert.equal(creates(fixture).length, 1);
    assert.equal(fixture.api.lastEvent?.details.index, 2);
    const mapping = await fixture.store.getMappingByColpId(scope, 'n2-anchored');
    assert.equal((await fixture.api.get(mapping?.nativeId ?? ''))[0]?.index, 2);
  });

  test('restore apply does not catch an anchor failure as index 0', async () => {
    const source = await readFile(new URL('../src/pull-restore-apply.ts', import.meta.url), 'utf8');
    assert.equal(/\.catch\(\(\) => 0\)/u.test(source), false);
    assert.equal(/nativeIndex\([^)]*\)\.catch\(/u.test(source), false);
  });
});
