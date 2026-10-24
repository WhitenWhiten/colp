import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-view.js';
import { projectReplicaHealth } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { PublicSyncAttention } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';

/**
 * Silent states (C-05, C-06, C-17f): the attention read carries what the chip,
 * the card and the Sync-center report need to tell a lost permission, a pause
 * that ends by itself and an item that clears by itself from a stop.
 */
const scope = { environment: 'production', serverId: 's', serverOrigin: 'https://known.example', accountId: 'a',
  browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 } as SyncScope;
const open = (waits: unknown[] = []) => ({ bootstrap: [], operationalTotal: waits.length, queue: [], pull: [], local: [], replica: [],
  waits, deletes: [], roots: new Set<string>(), nativeRoots: new Set<string>(), total: waits.length }) as never;
const NOW = 1_800_000_000_000;

async function attention(input: { firstRun?: string; engine?: Record<string, unknown>; permission?: boolean; waits?: unknown[] } = {}) {
  const store = {
    getScope: async () => ({ firstRun: input.firstRun ?? 'completed' }),
    getEngineState: async () => input.engine,
    listQueue: async () => [],
  };
  const response = await handleSyncAttentionRequest({ scope: async () => scope, store: store as never, openIssues: open(input.waits),
    ...(input.permission === undefined ? {} : { bookmarkPermission: async () => input.permission! }) });
  assert.ok(response.ok);
  return response.ok ? response.attention : (undefined as never);
}

describe('removed bookmark access (C-05)', () => {
  test('is named once sync is set up, and only then', async () => {
    assert.equal((await attention({ permission: false })).permissionRequired, true);
    assert.equal((await attention({ permission: false, firstRun: 'running' })).permissionRequired, true);
    assert.equal((await attention({ permission: false, firstRun: 'none' })).permissionRequired, undefined, 'never set up');
    assert.equal((await attention({ permission: false, firstRun: 'deferred' })).permissionRequired, undefined, 'set up later');
    assert.equal((await attention({ permission: true })).permissionRequired, undefined);
    assert.equal((await attention({})).permissionRequired, undefined, 'a read that is not asked to check says nothing');
  });

  test('the card says what happened and where to fix it, without a Retry that cannot help', async () => {
    const view = describeSyncAttention(syncAttentionInput(await attention({ permission: false }), undefined));
    assert.equal(view.recovery.show, true);
    assert.match(view.recovery.copy, /needs permission to read and change your bookmarks/u);
    assert.match(view.recovery.copy, /Allow bookmark access in the Folders tab/u);
    assert.equal(view.recovery.retry, false);
    assert.deepEqual([view.recovery.folders.show, view.recovery.folders.href, view.recovery.folders.label],
      [true, '#sync/folders', 'Open Folders']);
  });

  test('the Sync center hears of it: stopped, with a code the web has words for, and nothing to press', async () => {
    const projection = projectReplicaHealth({ attention: await attention({ permission: false }), issues: [] });
    assert.deepEqual([projection.state, projection.code, projection.actions], ['stopped', 'permission_required', []]);
  });
});

describe('a pause that ends by itself (C-06)', () => {
  const engine = (lastError: string, retryAt: number | undefined, trips = 2) => ({ phase: 'error', lastError, notBefore: retryAt ?? 0,
    recoveryFrozen: false, ...(retryAt === undefined ? {} : { circuitBreaker: { progress: 'p', failures: [], trips, retryAt } }) });

  test('a tripped breaker on a code that heals is a cooldown, with its deadline and its trips', async () => {
    const facts = await attention({ engine: engine('stale_replica', NOW + 600_000, 3) });
    assert.equal(facts.retryAutomatic, false);
    assert.equal(facts.coolingDown, true);
    assert.equal(facts.retryAt, NOW + 600_000);
    assert.equal(facts.breakerTrips, 3);
  });

  test('a halt, or an integrity stop that only a person ends, is not a cooldown', async () => {
    assert.equal((await attention({ engine: engine('queue_state_invalid', undefined) })).coolingDown, undefined);
    assert.equal((await attention({ engine: engine('pull_page_invalid', NOW + 600_000) })).coolingDown, undefined);
    assert.equal((await attention({ engine: engine('mapping_identity_conflict', NOW + 600_000) })).coolingDown, undefined, 'terminal');
  });

  test('the card says when it tries again, and a cooldown whose time just passed still resumes by itself', async () => {
    const facts = (retryAt: number) => ({ ...syncAttentionInput(undefined, undefined), coolingDown: true, retryAutomatic: false,
      lastError: 'stale_replica', retryAt, phase: 'error' });
    const future = describeSyncAttention(facts(Date.now() + 600_000));
    assert.match(future.recovery.copy, /paused after repeated errors and will try again at /u);
    assert.doesNotMatch(future.recovery.copy, /stopped/u);
    assert.equal(future.recovery.retry, true);
    const passed = describeSyncAttention(facts(Date.now() - 1_000));
    assert.match(passed.recovery.copy, /paused after repeated errors and tries again shortly/u);
    const halted = describeSyncAttention({ ...facts(0), coolingDown: false });
    assert.match(halted.recovery.copy, /stopped after repeated errors/u);
  });

  test('the Sync center is told a pause, not a stop, and Retry skips the wait', async () => {
    const cooling = projectReplicaHealth({ attention: await attention({ engine: engine('network_unavailable', NOW + 60_000) }), issues: [] });
    assert.deepEqual([cooling.state, cooling.code, cooling.actions], ['degraded', 'network_unavailable', ['retry']]);
    const halted = projectReplicaHealth({ attention: await attention({ engine: engine('queue_state_invalid', undefined) }), issues: [] });
    assert.deepEqual([halted.state, halted.code], ['stopped', 'queue_state_invalid']);
  });
});

describe('an item that clears by itself (C-17f)', () => {
  const wait = (waitReason: string) => ({ waitRef: 'w', intentId: 'i', colpId: 'node-1', title: 'Soup', waitReason, candidates: [],
    affectedRange: { parentNativeId: 'p' } });

  test('a wait for a parent folder is automatic and needs nobody; one that waits for an answer does', async () => {
    const dependency = await attention({ waits: [wait('waiting_dependency')] });
    assert.equal(dependency.nativeWaitPending, false);
    assert.equal(dependency.waitCount, 1);
    assert.deepEqual(dependency.issues?.map(issue => [issue.code, issue.recovery]), [['waiting_dependency', 'automatic']]);
    const unknown = await attention({ waits: [wait('native_result_unknown')] });
    assert.equal(unknown.nativeWaitPending, true);
    assert.equal(unknown.issues?.[0]?.recovery, undefined);
  });

  test('the card counts it as recovering, not as a decision', async () => {
    const view = describeSyncAttention(syncAttentionInput(await attention({ waits: [wait('waiting_dependency')] }), undefined));
    assert.match(view.recovery.copy, /1 item is waiting for automatic recovery\./u);
    assert.doesNotMatch(view.recovery.copy, /needs attention/u);
  });
});

describe('the report when nothing is wrong', () => {
  test('stays syncing', () => {
    const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
      nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: true };
    assert.equal(projectReplicaHealth({ attention: calm, issues: [] }).state, 'syncing');
  });
});
