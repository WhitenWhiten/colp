import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { discardExpiredRecoveryStaging, freezeScopeRecovery, shouldFreezePullApply } from '../src/pull-recovery-freeze.js';
import { inheritEngineFacts } from '../src/sync-state/engine-transition.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

/**
 * A-05 (S5 / SR-06): the three engine writes that bypass `transitionEngine`'s own
 * callers - `freezeScopeRecovery`, `rejectBootstrapAckAndRequireAuthorityRefresh` and
 * `unfreezeEvidenceEngineForSeed` - must re-state every optional cursor/connectivity
 * fact and must carry the revision they read. Without that, `cursorsConverged` and the
 * re-Ack decision read a cursor the replica never held, and a concurrent transition is
 * silently overwritten.
 */
const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

/** The exact optional facts SR-06 enumerates, in one readable expectation object. */
const FACTS = Object.freeze({
  lastPublishedCursor: 'cursor-published',
  lastAckedCursor: 'cursor-acked',
  lastPushServerCursor: 'cursor-push',
  lastPushOutcomeHint: 'repair',
  localProjectionOwner: 7,
  connectivityConfirmationRevision: 3,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });
afterEach(() => {
  vi.doUnmock('../src/sw/runtime.js'); vi.doUnmock('../src/sw/engine.js'); vi.doUnmock('../src/sw/scope.js');
  vi.resetModules();
});

async function frozenFixture() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:root-r' } });
  await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
    selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
  const engine = await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 100, recoveryFrozen: false,
    authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-1', ...FACTS });
  assert.deepEqual({ ...FACTS }, {
    lastPublishedCursor: engine.lastPublishedCursor, lastAckedCursor: engine.lastAckedCursor,
    lastPushServerCursor: engine.lastPushServerCursor, lastPushOutcomeHint: engine.lastPushOutcomeHint,
    localProjectionOwner: engine.localProjectionOwner,
    connectivityConfirmationRevision: engine.connectivityConfirmationRevision,
  });
  return { store, revision: engine.revision };
}

/**
 * The five durable-progress facts every engine write must re-state (A-05 / S5). They record what
 * this replica already reached, so losing one makes `cursorsConverged` and the re-Ack check read a
 * cursor the replica never held.
 */
function assertProgressFactsPreserved(engine: {
  readonly lastPublishedCursor?: string; readonly lastAckedCursor?: string;
  readonly lastPushServerCursor?: string; readonly lastPushOutcomeHint?: string;
  readonly connectivityConfirmationRevision?: number;
}) {
  assert.equal(engine.lastPublishedCursor, FACTS.lastPublishedCursor);
  assert.equal(engine.lastAckedCursor, FACTS.lastAckedCursor);
  assert.equal(engine.lastPushServerCursor, FACTS.lastPushServerCursor);
  assert.equal(engine.lastPushOutcomeHint, FACTS.lastPushOutcomeHint);
  assert.equal(engine.connectivityConfirmationRevision, FACTS.connectivityConfirmationRevision);
}

/**
 * A freeze additionally **releases** the local-projection claim instead of carrying it forward.
 * `localProjectionOwner` names the engine revision that is currently projecting; a freeze voids
 * that claim (a failed projector is the usual reason the freeze happens), and
 * `resumeLocalProjection` releases ownership only while `current.revision === claimed.revision` -
 * so a claim retained across a freeze (which bumps the revision) could never be released again.
 * `tests/local-projection-recovery.test.ts` pins the same contract by name: "projector identity
 * failure takes ownership away from local projection".
 */
function assertFrozenFactsPreserved(engine: { readonly localProjectionOwner?: number }
& Parameters<typeof assertProgressFactsPreserved>[0]) {
  assertProgressFactsPreserved(engine);
  assert.equal(engine.localProjectionOwner, undefined, 'a freeze releases the local projection claim');
}

/**
 * The F006 shape a cursor-window lapse reaches: an active scope, a completed (but not yet
 * acknowledged) Snapshot staging row, and its pending bootstrap Ack intent.
 */
async function bootstrapAckFixture(store: ReturnType<typeof createSyncStateStore>, suffix: string) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: [] });
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'r2', digest: 'sha256:root-r' } });
  await store.stageRecoveryPage(scope, { snapshotId: `snapshot-${suffix}`, revision: 'r2', syncCursor: `cursor-${suffix}`,
    capability: 'src1.capability', identityDigest: `identity-${suffix}`, rootNodeId: 'root-r', page: 0,
    pageDigest: 'sha256:page', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: [{ colpId: 'root-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root-r',
      mapping: { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root', nodeKind: 'folder',
        projection: { revision: 'r2', digest: 'sha256:root-r' } } }] });
  const body = JSON.stringify({ sessionId: 'session-acked', cursor: `cursor-${suffix}`, warnings: [] });
  await store.commitRecovery(scope, `snapshot-${suffix}`, { intentId: `bootstrap-${suffix}`, sessionId: 'session-acked',
    idempotencyKey: `bootstrap-${suffix}`, endpointIdentity: 'syncAck', mediaType: 'application/json',
    body, bodyDigest: createHash('sha256').update(body).digest('hex') });
  return `bootstrap-${suffix}`;
}

/**
 * `src/sw/evidence.ts` reaches the store through `sw/runtime.js`, so the evidence test binds
 * the runtime's `syncState` to the store under test and imports the module fresh. Only the
 * three sibling SW modules whose exports `evidence.ts` destructures are stubbed.
 */
async function importEvidenceWith(syncState: unknown) {
  vi.resetModules();
  vi.doMock('../src/sw/runtime.js', () => ({
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    extensionOrigin: () => 'chrome-extension://known-extension',
    safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
    store: { fence: { read: async () => ({ revoked: false }) } }, sw: {}, syncState,
    workCoordinator: { run: async <T>(_lane: string, work: () => Promise<T>) => work() },
  }));
  vi.doMock('../src/sw/engine.js', () => ({
    scheduleSyncEngineWake: async () => undefined, publicSyncEngineState: async () => null,
  }));
  vi.doMock('../src/sw/scope.js', () => ({
    currentSyncScope: async () => scope, currentSyncStatusAuthority: async () => undefined,
    loadConfig: async () => ({}), pushSessionAuthority: async () => undefined,
  }));
  return await import('../src/sw/evidence.js');
}

/**
 * The original `sync-state-store.test.ts` bootstrap-Ack scenario, which reuses the
 * `root-r` colpId for both its prior mapping and its staged Snapshot page.
 */
async function legacyBootstrapAckFixture(store: ReturnType<typeof createSyncStateStore>, suffix: string) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: [] });
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:old-root' } });
  await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
    selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
  await store.stageRecoveryPage(scope, { snapshotId: `legacy-${suffix}`, revision: 'r2',
    syncCursor: `${suffix}.normal`, capability: `${suffix}.normal`,
    identityDigest: `identity-${suffix}`, rootNodeId: 'root-r', page: 0, pageDigest: `sha256:${suffix}`,
    previousPageDigest: null, nextCursor: null, complete: true,
    nodes: [{ colpId: 'root-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root-r',
      mapping: { nativeId: 'native-root', colpId: 'root-r', rootNativeId: 'native-root', nodeKind: 'folder',
        projection: { revision: 'r2', digest: 'sha256:root-r' } } }] });
  const ackBody = JSON.stringify({ sessionId: 'session-stale', cursor: `${suffix}.normal`, warnings: [] });
  await store.commitRecovery(scope, `legacy-${suffix}`, { intentId: `bootstrap-${suffix}`,
    sessionId: 'session-stale', idempotencyKey: `bootstrap-${suffix}`, endpointIdentity: 'syncAck',
    mediaType: 'application/json', body: ackBody, bodyDigest: createHash('sha256').update(ackBody).digest('hex') });
  return `bootstrap-${suffix}`;
}

async function evidenceStore() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: [] });
  return store;
}

/** The seed's own engine write, which the unfreeze must CAS against. */
async function seedEngineWrite(store: ReturnType<typeof createSyncStateStore>) {
  await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 150, recoveryFrozen: true,
    authorityRefreshRequired: true, notBefore: 0, sessionId: 'session-evidence', ...FACTS,
    lastPushServerCursor: 'cursor-after-seed' });
  return (await store.getEngineState(scope))!.revision;
}

describe('A-05 freeze/direct-write CAS and field inheritance', () => {
  test('freezeScopeRecovery keeps every prior cursor fact and bumps the revision', async () => {
    const { store, revision } = await frozenFixture();
    const now = () => 5_000;
    await freezeScopeRecovery(store, scope, 'pull_apply_target_missing', now);
    const engine = (await store.getEngineState(scope))!;
    assertFrozenFactsPreserved(engine);
    assert.equal(engine.phase, 'recovery');
    assert.equal(engine.recoveryFrozen, true);
    assert.equal(engine.authorityRefreshRequired, true);
    assert.equal(engine.notBefore, 5_000);
    assert.equal(engine.lastError, 'pull_apply_target_missing');
    assert.equal(engine.sessionId, 'session-1');
    assert.equal(engine.revision, revision + 1);
    // The freeze still escalates the scope itself.
    assert.equal((await store.getScope(scope))?.lifecycle, 'recovery_required');
    assert.equal((await store.getScope(scope))?.metadata?.recoveryCode, 'pull_apply_target_missing');
    // SR-02's parallel lane keeps its FREEZE membership.
    assert.equal(shouldFreezePullApply(new Error('pull_apply_target_missing')), true);
    assert.equal(shouldFreezePullApply(new Error('pull_apply_evidence_missing')), true);
    store.close();
  });

  test('freezeScopeRecovery rejects a stale read instead of overwriting the concurrent transition', async () => {
    const { store, revision } = await frozenFixture();
    // The frozen revision the losing reader observed before a rival wake wrote.
    const stale = (await store.getEngineState(scope))!;
    assert.equal(stale.revision, revision);
    // A second handle over the same database is the concurrent writer. It advances the durable
    // engine row behind that read (the repository reads through IndexedDB, so the competitor's
    // write is durable immediately and the first handle's next read would see it).
    const competitor = createSyncStateStore({ indexedDB });
    await competitor.transitionEngine(scope, { phase: 'pushing', updatedAt: 200, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-1', ...FACTS,
      lastPushServerCursor: 'cursor-concurrent' });
    assert.equal((await competitor.getEngineState(scope))!.revision, revision + 1);
    let reads = 0;
    const racing = { ...store, async getEngineState(_input: SyncScope) {
      reads += 1;
      // The freeze reads the engine exactly once; hand it the pre-race row so the write is
      // attempted against the revision the caller actually observed.
      return stale;
    } };

    await assert.rejects(() => freezeScopeRecovery(racing, scope, 'pull_apply_target_missing', () => 5_000),
      /engine_revision_stale/);
    assert.equal(reads, 1, 'the freeze must have read before attempting the write');
    const engine = (await store.getEngineState(scope))!;
    assert.equal(engine.phase, 'pushing', 'the concurrent transition must survive');
    assert.equal(engine.recoveryFrozen, false);
    assert.equal(engine.lastPushServerCursor, 'cursor-concurrent');
    assert.equal(engine.revision, revision + 1);
    competitor.close(); store.close();
  });

  test('freezeScopeRecovery creates the engine row on a first-ever freeze (no prior revision)', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
      checkpoint: null, selectedRoots: [] });
    assert.equal(await store.getEngineState(scope), null);
    await freezeScopeRecovery(store, scope, 'pull_apply_evidence_missing', () => 6_000);
    const engine = (await store.getEngineState(scope))!;
    assert.equal(engine.phase, 'recovery');
    assert.equal(engine.recoveryFrozen, true);
    assert.equal(engine.revision, 1);
    store.close();
  });

  // Moved here from `sync-state-store.test.ts` (A-05 / SR-06), together with the sibling
  // test below: that file is a 568-line pre-existing suite with no granularity baseline
  // entry, so the 600-line new-file limit left no room for the new coverage there. These
  // two cases are the superset of the generic bootstrap-Ack checks, so they replace them.
  test('atomically discards a rejected bootstrap Ack and persists the authority refresh freeze', async () => {
    const store = createSyncStateStore({ indexedDB });
    const intentId = await legacyBootstrapAckFixture(store, 'spc2');
    await store.transitionEngine(scope, { phase: 'acking', updatedAt: 100, recoveryFrozen: true, notBefore: 0,
      sessionId: 'session-stale', ...FACTS, lastPublishedCursor: 'spc2.normal', authorityRefreshRequired: false });
    const priorRevision = (await store.getEngineState(scope))!.revision;

    await store.rejectBootstrapAckAndRequireAuthorityRefresh(scope, intentId, {
      sessionId: 'session-stale', updatedAt: 101, notBefore: 1_101, errorCode: 'stale_replica',
      expectedRevision: priorRevision });
    const exported = await store.exportScope(scope);
    assert.equal(exported.ackIntents.length, 0);
    assert.equal(exported.engine.phase, 'recovery'); assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.engine.lastError, 'stale_replica');
    assert.equal(exported.engine.revision, priorRevision + 1);
    // A-05 (S5 / SR-06): the reject is a straight engine write, so it must re-state the
    // optional facts instead of dropping them. This assertion previously pinned the defect
    // (`lastPublishedCursor === undefined`, i.e. a rejected bootstrap Ack erased the cursor
    // the replica had already published); `lastPublishedCursor` is now inherited, matching
    // the sibling coverage of `lastAckedCursor` below.
    assert.equal(exported.engine.lastPublishedCursor, 'spc2.normal');
    // The other durable-progress facts are re-stated too: this fixture's engine row carried
    // them all, and the pre-A-05 code kept only `lastAckedCursor`, by accident of being the one
    // field it spelled out. `localProjectionOwner` is deliberately *not* carried: a freeze
    // releases the local-projection claim (`inheritFrozenEngineFacts`).
    // That fixture's engine row carries the Snapshot cursor this reject must keep, not the
    // shared `FACTS` cursor, so the progress facts are asserted against it directly.
    assert.equal(exported.engine.lastAckedCursor, FACTS.lastAckedCursor);
    assert.equal(exported.engine.lastPushServerCursor, FACTS.lastPushServerCursor);
    assert.equal(exported.engine.lastPushOutcomeHint, FACTS.lastPushOutcomeHint);
    assert.equal(exported.engine.connectivityConfirmationRevision, FACTS.connectivityConfirmationRevision);
    assert.equal(exported.engine.localProjectionOwner, undefined, 'a freeze releases the local projection claim');
    store.close();
  });

  test('rejects a stale expected revision on the bootstrap Ack reject instead of overwriting', async () => {
    const store = createSyncStateStore({ indexedDB });
    const intentId = await legacyBootstrapAckFixture(store, 'spc3');
    await store.transitionEngine(scope, { phase: 'acking', updatedAt: 100, recoveryFrozen: true, notBefore: 0,
      sessionId: 'session-stale', authorityRefreshRequired: false });
    const readRevision = (await store.getEngineState(scope))!.revision;

    // A concurrent transition advances the durable revision behind the caller's read.
    await store.transitionEngine(scope, { phase: 'pulling', updatedAt: 101, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0, lastPushServerCursor: 'cursor-concurrent' });

    await assert.rejects(() => store.rejectBootstrapAckAndRequireAuthorityRefresh(scope, intentId, {
      sessionId: 'session-stale', updatedAt: 102, notBefore: 1_102, errorCode: 'stale_replica',
      expectedRevision: readRevision }), /engine_revision_stale/);
    const after = await store.exportScope(scope);
    assert.equal(after.ackIntents.length, 1, 'the intent must survive a stale reject');
    assert.equal(after.engine.phase, 'pulling');
    assert.equal(after.engine.lastPushServerCursor, 'cursor-concurrent');
    store.close();
  });

  test('discardExpiredRecoveryStaging still drops the bootstrap Ack through the CAS reject', async () => {
    const store = createSyncStateStore({ indexedDB });
    await bootstrapAckFixture(store, 'discard');
    // The exact shape the engine reaches before a cursor-expiry freeze: a frozen
    // recovery row, a pending bootstrap Ack, and the lapsed cursor still published.
    await store.transitionEngine(scope, { phase: 'bootstrap', updatedAt: 100, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, sessionId: 'session-acked', ...FACTS,
      lastPublishedCursor: 'cursor-discard' });
    const revision = (await store.getEngineState(scope))!.revision;

    const dropped = await discardExpiredRecoveryStaging(store, scope, 'sync_cursor_expired');
    assert.equal(dropped, true);
    const afterReject = (await store.getEngineState(scope))!;
    // The published cursor here is the lapsed one this replica really held; the other five
    // facts must survive the reject untouched.
    assert.equal(afterReject.lastPublishedCursor, 'cursor-discard');
    assert.equal(afterReject.lastAckedCursor, FACTS.lastAckedCursor);
    assert.equal(afterReject.lastPushServerCursor, FACTS.lastPushServerCursor);
    assert.equal(afterReject.lastPushOutcomeHint, FACTS.lastPushOutcomeHint);
    assert.equal(afterReject.localProjectionOwner, undefined, 'the reject is a freeze: the claim is released');
    assert.equal(afterReject.connectivityConfirmationRevision, FACTS.connectivityConfirmationRevision);
    assert.equal(afterReject.phase, 'recovery');
    assert.equal(afterReject.recoveryFrozen, true);
    assert.equal(afterReject.authorityRefreshRequired, true);
    assert.equal(afterReject.lastError, 'sync_cursor_expired');
    assert.equal(afterReject.revision, revision + 1);
    assert.equal((await store.listAckIntents(scope)).length, 0);
    assert.equal(await store.getRecoveryHeader(scope), null);
    assert.equal(await store.hasRecoveryStaging(scope), false);

    // The freeze that follows in production composes with the reject's revision.
    await freezeScopeRecovery(store, scope, 'sync_cursor_expired', () => 7_000);
    const frozen = (await store.getEngineState(scope))!;
    assert.equal(frozen.lastPublishedCursor, 'cursor-discard');
    assert.equal(frozen.lastAckedCursor, FACTS.lastAckedCursor);
    assert.equal(frozen.lastPushServerCursor, FACTS.lastPushServerCursor);
    assert.equal(frozen.lastPushOutcomeHint, FACTS.lastPushOutcomeHint);
    assert.equal(frozen.localProjectionOwner, undefined, 'the follow-up freeze keeps the claim released');
    assert.equal(frozen.connectivityConfirmationRevision, FACTS.connectivityConfirmationRevision);
    assert.equal(frozen.phase, 'recovery');
    assert.equal(frozen.revision, revision + 2);
    store.close();
  });

  test('inheritEngineFacts omits absent facts so a missing field stays missing', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
      checkpoint: null, selectedRoots: [] });
    assert.deepEqual(inheritEngineFacts(null), {});
    assert.deepEqual(inheritEngineFacts(undefined), {});
    const engine = await store.transitionEngine(scope, { phase: 'idle', updatedAt: 100, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, lastAckedCursor: 'cursor-only-ack' });
    // `validateEngineState`'s "omitted means dropped" strictness is the point: the helper
    // must not resurrect a field the prior row never held, or the omission stops being visible.
    assert.deepEqual(inheritEngineFacts(engine), { lastAckedCursor: 'cursor-only-ack' });
    store.close();
  });
});

describe('A-05 evidence seed unfreeze uses the same CAS and inheritance', () => {
  test('unfreezeEvidenceEngineForSeed keeps every prior cursor fact and bumps the revision', async () => {
    const store = await evidenceStore();
    const seedRevision = await seedEngineWrite(store);
    const { unfreezeEvidenceEngineForSeed } = await importEvidenceWith(store);

    await unfreezeEvidenceEngineForSeed(scope);
    const engine = (await store.getEngineState(scope))!;
    assert.equal(engine.phase, 'idle');
    assert.equal(engine.recoveryFrozen, false);
    assert.equal(engine.authorityRefreshRequired, false);
    assert.equal(engine.notBefore, 0);
    assert.equal(engine.sessionId, 'session-evidence');
    assert.equal(engine.revision, seedRevision + 1);
    assert.equal(engine.lastPublishedCursor, FACTS.lastPublishedCursor);
    assert.equal(engine.lastAckedCursor, FACTS.lastAckedCursor);
    assert.equal(engine.lastPushServerCursor, 'cursor-after-seed');
    assert.equal(engine.lastPushOutcomeHint, FACTS.lastPushOutcomeHint);
    assert.equal(engine.localProjectionOwner, FACTS.localProjectionOwner);
    assert.equal(engine.connectivityConfirmationRevision, FACTS.connectivityConfirmationRevision);
    store.close();
  });

  test('unfreezeEvidenceEngineForSeed refuses a stale read instead of overwriting the seed write', async () => {
    const store = await evidenceStore();
    await seedEngineWrite(store);
    const durable = (await store.getEngineState(scope))!;
    // The seed write a rival wake performed after the unfreeze's read.
    await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 200, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, sessionId: 'session-evidence', ...FACTS,
      lastPushServerCursor: 'cursor-rival' });
    const rivalRevision = (await store.getEngineState(scope))!.revision;
    let reads = 0;
    const racing = { ...store, async getEngineState(input: SyncScope) {
      reads += 1; return reads === 1 ? durable : await store.getEngineState(input);
    } };
    const { unfreezeEvidenceEngineForSeed } = await importEvidenceWith(racing);

    await assert.rejects(() => unfreezeEvidenceEngineForSeed(scope), /engine_revision_stale/);
    assert.equal(reads, 1, 'the unfreeze must have read before attempting the write');
    const engine = (await store.getEngineState(scope))!;
    assert.equal(engine.phase, 'recovery', 'the rival seed write must survive');
    assert.equal(engine.recoveryFrozen, true);
    assert.equal(engine.lastPushServerCursor, 'cursor-rival');
    assert.equal(engine.revision, rivalRevision);
    store.close();
  });
});
