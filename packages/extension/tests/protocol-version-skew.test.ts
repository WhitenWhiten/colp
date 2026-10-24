import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { authoritativeEffectPage, syncAckResult, syncPullV02, syncSnapshotV02 } from '../src/generated/pull-effect-validators.js';
import { schemaRejection } from '../src/durable-sync-engine-errors.js';
import { discoverSyncEndpoints } from '../src/manifest-client.js';
import { parseSyncSessionResult } from '../src/session-client.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { NOW, config, fixtureSessionRequest, fixtureSessionResult, manifest } from './auth-shell-fixture.js';
import { ack, emptyPullPage, json, scope, setup, snapshot } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/**
 * W2C-12 / A-F10: the protocol demands strict same-version validation, and that stays. A response that fails it ONLY
 * because it carries a field this build does not know (a newer server) is named `server_version_mismatch` so the
 * person is told to update, instead of the generic integrity code of a corrupt page. Everything else keeps its code.
 */
const code = (validator: Parameters<typeof schemaRejection>[0], integrity: Parameters<typeof schemaRejection>[1]) =>
  schemaRejection(validator, integrity).code;

describe('the failure table', () => {
  test('a version mismatch is a named stop of the replica, with no freeze of Pull', () => {
    const entry = classifySyncFailure('server_version_mismatch');
    assert.deepEqual({ class: entry?.class, exit: entry?.exit, freezes: entry?.freezesPull }, { class: 'replica', exit: 'stop', freezes: undefined });
  });
});

describe('Pull, Ack, Snapshot and effect pages', () => {
  const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: 'c1', parentId: 'root-colp' });
  const page = pullFixtures.page({ events: [event], nextCursor: 'cursor-1', collectionRevision: 'r1' }) as Record<string, any>;

  test('an unknown field at any depth is a version mismatch', () => {
    for (const [label, body] of [
      ['page', { ...page, futureField: 1 }],
      ['event', { ...page, events: [{ ...page.events[0], futureField: 1 }] }],
      ['operation', { ...page, events: [{ ...page.events[0], operation: { ...page.events[0].operation, futureField: 1 } }] }],
      ['effect node', { ...page, events: [{ ...page.events[0], effect: { ...page.events[0].effect,
        node: { ...page.events[0].effect.node, futureField: 1 } } }] }],
    ] as const) {
      assert.equal(syncPullV02(body), false, label);
      assert.equal(code(syncPullV02, 'pull_invalid'), 'server_version_mismatch', label);
    }
  });

  test('a missing field, a wrong type and an unknown kind keep the integrity code', () => {
    const { recommendedPullAfterSeconds: _dropped, ...missing } = page;
    for (const [label, body] of [['missing', missing], ['wrong type', { ...page, hasMore: 'yes' }],
      ['unknown kind', { ...page, events: [{ ...page.events[0], effect: { ...page.events[0].effect, kind: 'node_teleported' } }] }],
      ['not an object', 42]] as const) {
      assert.equal(syncPullV02(body), false, label);
      assert.equal(code(syncPullV02, 'pull_invalid'), 'pull_invalid', label);
    }
  });

  test('Ack, Snapshot and effect pages follow the same rule', () => {
    assert.equal(syncAckResult({ ...ack('cursor-1'), futureField: 1 }), false);
    assert.equal(code(syncAckResult, 'ack_invalid'), 'server_version_mismatch');
    assert.equal(syncAckResult({ replicaId: 'r' }), false);
    assert.equal(code(syncAckResult, 'ack_invalid'), 'ack_invalid');
    const first = snapshot(1, false, null);
    assert.equal(syncSnapshotV02({ ...first, futureField: 1 }), false);
    assert.equal(code(syncSnapshotV02, 'snapshot_invalid'), 'server_version_mismatch');
    assert.equal(syncSnapshotV02({ ...first, nodes: [{ ...first.nodes[0], futureField: 1 }] }), false);
    assert.equal(code(syncSnapshotV02, 'snapshot_invalid'), 'server_version_mismatch');
    assert.equal(syncSnapshotV02({ ...first, mode: 'quantum' }), false);
    assert.equal(code(syncSnapshotV02, 'snapshot_invalid'), 'snapshot_invalid');
    const subtree = pullFixtures.subtreeEvent({ sequence: 2, collectionId: 'c1', targetId: 'node-1', members: ['node-1'], paged: true });
    const effectPage = (subtree as unknown as { __effectPages: Array<Record<string, unknown>> }).__effectPages[0]!;
    assert.equal(authoritativeEffectPage(effectPage), true);
    assert.equal(authoritativeEffectPage({ ...effectPage, futureField: 1 }), false);
    assert.equal(code(authoritativeEffectPage, 'effect_page_invalid'), 'server_version_mismatch');
    const { pageDigest: _dropped, ...unsigned } = effectPage;
    assert.equal(authoritativeEffectPage(unsigned), false);
    assert.equal(code(authoritativeEffectPage, 'effect_page_invalid'), 'effect_page_invalid');
  });
});

describe('the engine', () => {
  test('a Pull page with an unknown field stops the engine with the named code, not pull_invalid', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, { ...emptyPullPage('cursor-1'), futureField: 1 }));
    await fixture.engine.wake('manual');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.deepEqual([state.phase, state.lastError], ['error', 'server_version_mismatch']);
  });

  test('a Pull page that is merely malformed is still pull_invalid', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, { malformed: true }));
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.getEngineState(scope))!.lastError, 'pull_invalid');
  });

  test('an Ack result with an unknown field is a version mismatch; a wrong replica is still ack_invalid', async () => {
    const skewed = await setup();
    skewed.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    skewed.ackResponses.push(json(200, { ...ack('cursor-1'), futureField: 1 }));
    await skewed.engine.wake('manual');
    assert.equal((await skewed.store.getEngineState(scope))!.lastError, 'server_version_mismatch');
    const wrong = await setup();
    wrong.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    wrong.ackResponses.push(json(200, { ...ack('cursor-1'), replicaId: 'other-replica' }));
    await wrong.engine.wake('manual');
    assert.equal((await wrong.store.getEngineState(scope))!.lastError, 'ack_invalid');
  });
});

describe('the Session response', () => {
  const parse = (value: unknown) => {
    try { parseSyncSessionResult(value, fixtureSessionRequest(), 'a'.repeat(64)); return 'accepted'; }
    catch (error) { return (error as Error).message; }
  };
  const valid = () => structuredClone(fixtureSessionResult(NOW)) as Record<string, any>;

  test('is accepted as it is today', () => { assert.equal(parse(valid()), 'accepted'); });

  test('an unknown field at the top or in a nested object is a version mismatch', () => {
    for (const mutate of [
      (value: Record<string, any>) => { value.futureField = 1; },
      (value: Record<string, any>) => { value.collection.futureField = 1; },
      (value: Record<string, any>) => { value.replicaLease.futureField = 1; },
      (value: Record<string, any>) => { value.conversionPolicy.futureField = 1; },
    ]) {
      const value = valid(); mutate(value);
      assert.equal(parse(value), 'server_version_mismatch');
    }
  });

  test('a missing field or a wrong value is still session_invalid', () => {
    for (const mutate of [
      (value: Record<string, any>) => { delete value.sessionId; },
      (value: Record<string, any>) => { delete value.collection.serverCursor; },
      (value: Record<string, any>) => { value.acceptedProtocolVersion = '0.3'; },
      (value: Record<string, any>) => { value.replicaLease.state = 'expired'; },
    ]) {
      const value = valid(); mutate(value);
      assert.equal(parse(value), 'session_invalid');
    }
    assert.equal(parse('not an object'), 'session_invalid');
  });
});

describe('the manifest', () => {
  const discover = (mutate: (value: Record<string, any>) => void) => {
    const value = structuredClone(manifest()) as Record<string, any>; mutate(value);
    try { discoverSyncEndpoints(value, config()); return 'accepted'; } catch (error) { return (error as Error).message; }
  };

  test('is accepted as it is today', () => { assert.equal(discover(() => undefined), 'accepted'); });

  test('an unknown top-level or mount field is a version mismatch', () => {
    assert.equal(discover((value) => { value.futureField = true; }), 'server_version_mismatch');
    assert.equal(discover((value) => { value.mounts[0].futureProfile = true; }), 'server_version_mismatch');
  });

  test('a server that no longer speaks this protocol version is a version mismatch', () => {
    assert.equal(discover((value) => { value.protocolVersions = ['0.3']; }), 'server_version_mismatch');
    assert.equal(discover((value) => { value.protocolVersions = 'nonsense'; }), 'manifest_invalid');
  });

  test('other manifest faults keep their own codes', () => {
    assert.equal(discover((value) => { delete value.mounts[0].endpoints.syncPull; }), 'manifest_mount_ambiguous');
    assert.equal(discover((value) => { value.serverId = 'https://evil.example/'; }), 'manifest_schema_invalid');
    assert.equal(discover((value) => { value.mounts[0].profiles.push('sync'); }), 'manifest_boundary_invalid');
  });
});
