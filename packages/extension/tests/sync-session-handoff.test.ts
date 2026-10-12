import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readEngineSessionAuthority } from '../src/sync-session-handoff.js';
import { syncSessionNeedsRenewal } from '../src/session-client.js';
import type { StoredSession } from '../src/types.js';
import { setup, scope, json, emptyPullPage, ack } from './durable-sync-engine-harness.js';

async function fixture(acknowledged = true) {
  const f = await setup({ useRealPullApplier: true });
  f.pullResponses.push(json(200, emptyPullPage('cursor-confirmed'), { 'Known-Sync-Cursor-Reissued': 'true' }));
  f.ackResponses.push(acknowledged ? json(200, ack('cursor-confirmed')) : json(503, {}));
  await f.engine.wake('manual');
  const session = { sessionId: 'session-new', acceptedProtocolVersion: '0.2',
    scope: 'collection', snapshotRequired: false, expiresAt: '2099-01-01T00:00:00Z',
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-reissued', serverRevision: 'revision-1' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
  } as StoredSession;
  const options = { store: f.store, scope, sessions: { async get() {
    return { credential: { accessToken: 'token' }, session };
  } } };
  return { ...f, session, options };
}

test('adopts a renewed Session token at an acknowledged boundary without Snapshot recovery', async () => {
  const f = await fixture();
  try {
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-reissued');
    const state = await f.store.getEngineState(scope);
    assert.equal(state?.sessionId, 'session-new'); assert.equal(state?.recoveryFrozen, false);
    assert.equal(f.snapshotRequests.length, 0);
  } finally { f.store.close(); }
});

test('adopts a further renewal after the prior Session-issued cursor was confirmed', async () => {
  const f = await fixture();
  try {
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.listAckIntents(scope)).some(ack => ack.cursor === 'cursor-reissued'), false);
    const next = { ...f.session, sessionId: 'session-next',
      collection: { ...f.session.collection, serverCursor: 'cursor-next' } };
    f.options.sessions.get = async () => ({ credential: { accessToken: 'token' }, session: next });
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
    const state = await f.store.getEngineState(scope);
    assert.equal(state?.sessionId, 'session-next');
    assert.equal(state?.lastPublishedCursor, 'cursor-next');
    assert.equal(state?.lastAckedCursor, 'cursor-next');
    assert.equal(state?.recoveryFrozen, false);
    assert.equal(f.snapshotRequests.length, 0);
  } finally { f.store.close(); }
});

test('Session authority evidence requires a matching engine acknowledgement, including the atomic recheck', async () => {
  const f = await fixture();
  try {
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    const prior = (await f.store.getEngineState(scope))!;
    await f.store.transitionEngine(scope, { ...prior, lastAckedCursor: 'cursor-confirmed',
      expectedRevision: prior.revision });
    const next = { ...f.session, sessionId: 'session-next',
      collection: { ...f.session.collection, serverCursor: 'cursor-next' } };
    f.options.sessions.get = async () => ({ credential: { accessToken: 'token' }, session: next });
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-reissued');
    assert.equal((await f.store.getEngineState(scope))?.sessionId, 'session-new');

    const current = (await f.store.getEngineState(scope))!;
    const frozen = await f.store.transitionEngine(scope, { ...current,
      recoveryFrozen: true, authorityRefreshRequired: true, expectedRevision: current.revision });
    await assert.rejects(f.store.rebaseActiveSessionAuthority(scope, {
      cursor: 'cursor-next', serverRevision: 'revision-1',
      expectedEngineRevision: frozen.revision, requireConfirmedCursor: 'cursor-reissued',
    }), /session_handoff_pending/u);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-reissued');
  } finally { f.store.close(); }
});

test('preserves the original Ack request and local cursor while an Ack is pending', async () => {
  const f = await fixture(false);
  try {
    const pending = await f.store.getPendingAckIntent(scope);
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-confirmed');
    assert.deepEqual(await f.store.getPendingAckIntent(scope), pending);
  } finally { f.store.close(); }
});

test('does not overwrite local progress from an incomplete Pull page', async () => {
  const f = await fixture();
  try {
    await f.store.stagePullPage(scope, { pageId: 'unfinished', previousCursor: 'cursor-confirmed',
      nextCursor: 'cursor-local', collectionRevision: 'revision-local', pageDigest: 'digest', events: [] });
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-confirmed');
    assert.equal((await f.store.listPullPages(scope, ['staged'])).length, 1);
  } finally { f.store.close(); }
});

test('renews the Session before the token deadline', async () => {
  const f = await fixture();
  try {
    assert.equal(syncSessionNeedsRenewal({ ...f.session,
      expiresAt: new Date(f.clock.now + 59_000).toISOString() }, f.clock.now), true);
  } finally { f.store.close(); }
});

test('rechecks pending browser work atomically when it races Session migration', async () => {
  const f = await fixture();
  const rebase = f.store.rebaseActiveSessionAuthority;
  try {
    f.options.store = { ...f.store, async rebaseActiveSessionAuthority(scope, checkpoint) {
      await f.store.stagePullPage(scope, { pageId: 'racing-page', previousCursor: 'cursor-confirmed',
        nextCursor: 'cursor-racing', collectionRevision: 'revision-racing', pageDigest: 'digest', events: [] });
      return rebase(scope, checkpoint);
    } };
    await assert.rejects(readEngineSessionAuthority(f.options, () => f.clock.now), /session_handoff_pending/u);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-confirmed');
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, false);
    assert.equal((await f.store.listPullPages(scope, ['staged'])).length, 1);
  } finally { f.store.close(); }
});
