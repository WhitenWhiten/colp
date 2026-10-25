import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createSyncWatchdog, WATCHDOG_MARKER_KEY } from '../src/sw/sync-watchdog.js';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-view.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { projectReplicaHealth } from '../src/sw/replica-health-report.js';
import { attentionStatusKind, projectSyncStatus } from '../src/sync-status.js';
import {
  evaluateWatchdog, watchdogMarkerChanged, WATCHDOG_CONFIRM_AFTER_MS, WATCHDOG_NO_PASS_AFTER_MS, WATCHDOG_STUCK_AFTER_MS,
  type WatchdogFacts, type WatchdogMarker,
} from '../src/sync-watchdog.js';
import type { PublicSyncAttention } from '../src/types.js';
import type { DurableSyncEngineState, SyncScope } from '../src/sync-state-store.js';

/**
 * S6 (K6): the watchdog tells a stall nothing classified. Thresholds are the
 * plan's (doc 21 §3): the oldest change not moving for 10 minutes, no clean
 * pass for 60, each only after it has held for a few minutes more, and never
 * when something else already explains the silence.
 */
const MIN = 60_000;
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const facts = (over: Partial<WatchdogFacts> & { now: number }): WatchdogFacts =>
  ({ sessionStart: T0 - 24 * 60 * MIN, explained: false, passEnded: true, ...over });

/** Samples a stall every minute until it is told, or the horizon passes. */
function run(start: WatchdogMarker | undefined, make: (now: number) => WatchdogFacts, from: number, to: number, step = MIN) {
  let marker = start; let told: number | undefined; let verdict;
  for (let now = from; now <= to; now += step) {
    const result = evaluateWatchdog(marker, make(now));
    marker = result.marker;
    if (result.verdict && told === undefined) { told = now; verdict = result.verdict; }
  }
  return { marker, told, verdict };
}

describe('the thresholds are one set of constants', () => {
  test('10 minutes without moving, 60 without a pass, 5 to be sure', () => {
    assert.equal(WATCHDOG_STUCK_AFTER_MS, 10 * MIN);
    assert.equal(WATCHDOG_NO_PASS_AFTER_MS, 60 * MIN);
    assert.equal(WATCHDOG_CONFIRM_AFTER_MS, 5 * MIN);
  });
});

describe('the oldest change has not moved', () => {
  const head = { opId: 'op-1', title: 'Recipes' };
  const sample = (now: number): WatchdogFacts => facts({ now, head, engineUpdatedAt: now - 20_000 });

  test('is told once it has sat at the head for 10 minutes and the doubt has lasted 5 more', () => {
    const { told, verdict } = run(undefined, sample, T0, T0 + 40 * MIN);
    // First seen at T0; at T0+10 it has not moved for 10 minutes, and 5 minutes later that is confirmed.
    assert.equal(told, T0 + 15 * MIN);
    assert.deepEqual(verdict, { kind: 'stuck', since: T0, title: 'Recipes' });
  });

  test('is not told while the lane is moving: a new head is progress', () => {
    const moving = (now: number): WatchdogFacts => facts({ now, head: { opId: `op-${Math.floor((now - T0) / (4 * MIN))}` }, engineUpdatedAt: now });
    assert.equal(run(undefined, moving, T0, T0 + 3 * 60 * MIN).told, undefined);
  });

  test('is not told when something else explains it', () => {
    const explained = (now: number): WatchdogFacts => facts({ now, head, explained: true });
    assert.equal(run(undefined, explained, T0, T0 + 3 * 60 * MIN).told, undefined);
  });

  test('a browser that has just started has not had time to upload anything', () => {
    const justStarted = (now: number): WatchdogFacts => facts({ now, head, sessionStart: T0 + 50 * MIN });
    // The marker remembers the change at the head for three hours; the browser has been running for two minutes.
    const marker: WatchdogMarker = { version: 1, head: { opId: 'op-1', since: T0 - 180 * MIN } };
    assert.equal(evaluateWatchdog(marker, justStarted(T0 + 52 * MIN)).verdict, undefined);
    assert.equal(run(marker, justStarted, T0 + 52 * MIN, T0 + 55 * MIN).told, undefined);
    assert.ok(run(marker, justStarted, T0 + 52 * MIN, T0 + 90 * MIN).told !== undefined, 'but it is told if the stall outlasts the grace');
  });

  test('a doubt that lifts before it is confirmed is forgotten', () => {
    const lifted = (now: number): WatchdogFacts => facts({ now, head: now < T0 + 12 * MIN ? head : undefined, engineUpdatedAt: now - 20_000 });
    const result = run(undefined, lifted, T0, T0 + 20 * MIN);
    assert.equal(result.told, undefined);
    assert.equal(result.marker?.suspect, undefined);
  });
});

describe('no pass has ended cleanly (no_pass)', () => {
  test('is told after an hour and the 5 minutes of doubt', () => {
    const stale = (now: number): WatchdogFacts => facts({ now, passEnded: false, engineUpdatedAt: now - 5 * MIN });
    const start: WatchdogMarker = { version: 1, lastPassAt: T0 };
    const { told, verdict } = run(start, stale, T0 + MIN, T0 + 120 * MIN);
    assert.equal(told, T0 + 65 * MIN);
    assert.deepEqual(verdict, { kind: 'no_pass', since: T0 });
  });

  test('a clean pass resets it, and the engine state itself is the evidence of one', () => {
    const marker: WatchdogMarker = { version: 1, lastPassAt: T0 - 59 * MIN };
    const clean = evaluateWatchdog(marker, facts({ now: T0, passEnded: true, engineUpdatedAt: T0 - 20_000 }));
    assert.equal(clean.lastSyncedAt, T0 - 20_000);
    assert.equal(run(clean.marker, now => facts({ now, passEnded: true, engineUpdatedAt: now - 20_000 }), T0, T0 + 4 * 60 * MIN).told, undefined);
  });

  test('a stalled engine in a state that never ends a pass is told even though it records no error', () => {
    const pulling = (now: number): WatchdogFacts => facts({ now, passEnded: false, engineUpdatedAt: T0 - 90 * MIN });
    assert.ok(run({ version: 1, lastPassAt: T0 - 90 * MIN }, pulling, T0, T0 + 10 * MIN).told !== undefined);
  });

  test('is quiet when the engine is paused, offline or in error: those say so themselves', () => {
    const explained = (now: number): WatchdogFacts => facts({ now, passEnded: false, explained: true });
    assert.equal(run({ version: 1, lastPassAt: T0 - 300 * MIN }, explained, T0, T0 + 3 * 60 * MIN).told, undefined);
  });
});

describe('what is written', () => {
  test('a marker is written when it learns something, not every time the clock moves', () => {
    const marker: WatchdogMarker = { version: 1, lastPassAt: T0, head: { opId: 'a', since: T0 } };
    assert.equal(watchdogMarkerChanged(undefined, marker), true);
    assert.equal(watchdogMarkerChanged(marker, { ...marker, lastPassAt: T0 + 30_000 }), false);
    assert.equal(watchdogMarkerChanged(marker, { ...marker, lastPassAt: T0 + 61_000 }), true);
    assert.equal(watchdogMarkerChanged(marker, { ...marker, head: { opId: 'b', since: T0 + 5 } }), true);
    assert.equal(watchdogMarkerChanged(marker, { ...marker, suspect: { kind: 'stuck', since: T0 } }), true);
  });
});

describe('the worker keeps the marker', () => {
  const scope = { replicaId: 'replica-1' } as SyncScope;
  const engine = (over: Partial<DurableSyncEngineState> = {}) => ({ phase: 'sleeping', updatedAt: T0 - 20_000, ...over }) as DurableSyncEngineState;
  function area() {
    const values = new Map<string, unknown>();
    return { values, get: async (key: string) => (values.has(key) ? { [key]: values.get(key) } : {}) as Record<string, unknown>,
      set: async (next: Record<string, unknown>) => { for (const [key, value] of Object.entries(next)) values.set(key, value); } };
  }
  const row = (opId: string, title?: string) => ({ opId, payload: { type: 'create_node', targetId: 'pending-x', occurredAt: '2026-10-24T08:00:00.000Z',
    payload: { node: { kind: 'bookmark', ...(title ? { title } : {}) } } } }) as never;

  test('remembers the head across worker restarts, so ten minutes means ten minutes', async () => {
    const local = area(); const session = area(); let clock = T0; const head = row('op-1', 'Recipes');
    const make = () => createSyncWatchdog({ local, session, now: () => clock, head: async () => head });
    // The session began long ago (the session store already has it).
    session.values.set('known.sync.watchdog.session', T0 - 600 * MIN);
    let told;
    for (let minute = 0; minute <= 16; minute++) {
      clock = T0 + minute * MIN;
      const result = await make().sample({ scope, engine: engine({ updatedAt: clock - 20_000 }), explained: false });
      if (result?.verdict && told === undefined) told = [minute, result.verdict];
    }
    assert.deepEqual(told, [15, { kind: 'stuck', since: T0, title: 'Recipes' }]);
    assert.equal((local.values.get(WATCHDOG_MARKER_KEY) as { replicaId: string }).replicaId, 'replica-1');
  });

  test('a browser restart (an empty session store) starts every clock again', async () => {
    const local = area(); const session = area();
    local.values.set(WATCHDOG_MARKER_KEY, { replicaId: 'replica-1', marker: { version: 1, head: { opId: 'op-1', since: T0 - 600 * MIN } } });
    const watchdog = createSyncWatchdog({ local, session, now: () => T0, head: async () => row('op-1') });
    const result = await watchdog.sample({ scope, engine: engine(), explained: false });
    assert.equal(result?.verdict, undefined);
    assert.equal(session.values.get('known.sync.watchdog.session'), T0, 'and remembers when this session began');
  });

  test('a paused, disconnected or unavailable personal sync explains the silence; a marker of another replica is ignored', async () => {
    const local = area(); const session = area(); session.values.set('known.sync.watchdog.session', T0 - 600 * MIN);
    local.values.set(WATCHDOG_MARKER_KEY, { replicaId: 'replica-1', marker: { version: 1, head: { opId: 'op-1', since: T0 - 90 * MIN },
      suspect: { kind: 'stuck', since: T0 - 80 * MIN } } });
    const paused = createSyncWatchdog({ local, session, now: () => T0, head: async () => row('op-1'), mode: async () => 'paused' });
    assert.equal((await paused.sample({ scope, engine: engine(), explained: false }))?.verdict, undefined);
    const enabled = createSyncWatchdog({ local, session, now: () => T0, head: async () => row('op-1'), mode: async () => 'enabled' });
    assert.equal((await enabled.sample({ scope: { replicaId: 'replica-2' } as SyncScope, engine: engine(), explained: false }))?.verdict, undefined,
      'a new replica starts from nothing');
  });

  test('says nothing, and never throws, when its stores fail', async () => {
    const broken = { get: async () => { throw new Error('storage_unavailable'); }, set: async () => { throw new Error('storage_unavailable'); } };
    const watchdog = createSyncWatchdog({ local: broken, session: broken, now: () => T0, head: async () => { throw new Error('closed'); } });
    assert.equal(await watchdog.sample({ scope, engine: engine(), explained: false }), undefined);
    assert.equal(await watchdog.sample({ scope, engine: undefined, explained: false }), undefined);
  });
});

describe('what the attention read, the chip, the report and the card do with a verdict', () => {
  const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: true };
  const stuck = { ...calm, watchdog: { kind: 'stuck' as const, since: T0, title: 'Recipes' }, lastSyncedAt: T0 - 5 * MIN };
  const stalled = { ...calm, watchdog: { kind: 'no_pass' as const, since: T0 }, lastSyncedAt: T0 };

  test('the chip names it, below anything that is already named', () => {
    assert.deepEqual(attentionStatusKind(stuck), 'stuck');
    assert.deepEqual(attentionStatusKind(stalled), 'stalled');
    assert.equal(attentionStatusKind({ ...stuck, issueCount: 1 }), 'action-required');
    assert.equal(attentionStatusKind({ ...stuck, conflictPending: true }), 'review-conflicts');
    assert.equal(projectSyncStatus('stuck').label, 'Sync is stuck');
    assert.equal(projectSyncStatus('stalled').label, 'Sync hasn’t completed in a while');
  });

  test('the Sync center is told degraded with a code it has words for, and a Retry', () => {
    const stuckReport = projectReplicaHealth({ attention: stuck, issues: [] });
    assert.deepEqual([stuckReport.state, stuckReport.code, stuckReport.actions], ['degraded', 'sync_stuck', ['retry']]);
    assert.equal(projectReplicaHealth({ attention: stalled, issues: [] }).code, 'sync_not_completing');
    assert.equal(projectReplicaHealth({ attention: calm, issues: [] }).state, 'syncing');
  });

  test('the card says where it is stuck, since when, what to press, and when it last worked', () => {
    const view = describeSyncAttention(syncAttentionInput(stuck, undefined));
    assert.equal(view.recovery.show, true);
    assert.match(view.recovery.copy, /^Sync is stuck at “Recipes”: this upload has not moved since /u);
    assert.match(view.recovery.copy, /Retry sync tries again now\./u);
    assert.match(view.recovery.copy, /\(sync_stuck\)$/u);
    assert.equal(view.recovery.retry, true);
    assert.match(view.notes.lines[0]!, /^Last synced /u);
    const untitled = describeSyncAttention(syncAttentionInput({ ...stuck, watchdog: { kind: 'stuck', since: T0 } }, undefined));
    assert.match(untitled.recovery.copy, /^Sync is stuck: the oldest change waiting to upload has not moved since /u);
    const noPass = describeSyncAttention(syncAttentionInput(stalled, undefined));
    assert.match(noPass.recovery.copy, /^Sync has not finished a pass since .+, and nothing says why\./u);
    assert.match(noPass.recovery.report, /watchdog: no_pass since 2026-10-24T09:00:00\.000Z/u);
    assert.match(noPass.recovery.report, /lastSynced: 2026-10-24T09:00:00\.000Z/u);
  });

  test('a calm card does not say when it last synced', () => {
    const view = describeSyncAttention(syncAttentionInput({ ...calm, lastSyncedAt: T0 }, undefined));
    assert.equal(view.recovery.show, false);
    assert.deepEqual(view.notes.lines, []);
  });

  test('the attention read asks the watchdog only about silences nothing else explains, and carries its answer', async () => {
    const asked: boolean[] = [];
    const scope = { environment: 'production', serverId: 's', serverOrigin: 'https://known.example', accountId: 'a',
      browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 } as SyncScope;
    const read = async (engineState: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => {
      const store = { getScope: async () => ({ firstRun: 'completed' }), getEngineState: async () => engineState, listQueue: async () => [] };
      const response = await handleSyncAttentionRequest({ scope: async () => scope, store: store as never,
        openIssues: { bootstrap: [], operationalTotal: 0, queue: [], pull: [], local: [], replica: [], waits: [], deletes: [],
          roots: new Set<string>(), nativeRoots: new Set<string>(), total: 0 } as never,
        watchdog: { sample: async input => { asked.push(input.explained);
          return { marker: { version: 1 }, verdict: { kind: 'stuck', since: T0 }, lastSyncedAt: T0 - MIN }; } }, ...extra });
      assert.ok(response.ok); return response.ok ? response.attention : (undefined as never);
    };
    const idle = await read({ phase: 'sleeping', updatedAt: T0, recoveryFrozen: false, notBefore: 0 });
    assert.deepEqual(idle.watchdog, { kind: 'stuck', since: T0 });
    assert.equal(idle.lastSyncedAt, T0 - MIN);
    await read({ phase: 'offline', updatedAt: T0, lastError: 'network_unavailable', recoveryFrozen: false, notBefore: T0 + MIN });
    await read({ phase: 'error', updatedAt: T0, lastError: 'queue_state_invalid', recoveryFrozen: false, notBefore: 0 });
    assert.deepEqual(asked, [false, true, true]);
  });
});
