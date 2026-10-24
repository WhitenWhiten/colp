import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { STALLED_BUCKET_PREFIX, STOP_BUCKET_PREFIX } from '../src/sync-circuit-breaker.js';
import { SYNC_FAILURE_TABLE, persistentLocalSyncFailure, refreshesReplicaIntegrity, type SyncFailureEntry } from '../src/sync-failure-class.js';
import { collectSyncDiagnostics } from '../src/sync-diagnostics.js';
import { syncAttentionTerminalCode, syncStopState } from '../src/sync-stop-state.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { SyncScope } from '../src/sync-state-store.js';

/**
 * Plan item "unify the three terminal predicates": the engine (`persistentLocalSyncFailure`), the Status card
 * (`syncAttentionTerminalCode`) and the Help diagnostic (`collectSyncDiagnostics`) answered "has sync stopped"
 * separately. They read the table through `syncStopState` now; this walks the table and the real consumers.
 */
const table = Object.entries(SYNC_FAILURE_TABLE) as [string, SyncFailureEntry][];
const NOW = 1_800_000_000_000;

describe('one reading per table entry', () => {
  test('a rebuild or decide exit is terminal, a stop exit is stopped, and nothing else stops sync by itself', () => {
    const disagreements: string[] = [];
    for (const [code, entry] of table) {
      const state = syncStopState({ lastError: code, phase: 'error' });
      const expected = entry.exit === 'rebuild' || entry.exit === 'decide' ? 'terminal' : entry.exit === 'stop' ? 'stopped' : undefined;
      if (state?.kind !== expected) disagreements.push(`${code} (${entry.class}/${entry.exit}): ${state?.kind ?? 'none'}, expected ${expected ?? 'none'}`);
      if (state && state.code !== code) disagreements.push(`${code}: names ${state.code}`);
    }
    assert.deepEqual(disagreements, []);
  });

  test('the engine\'s own gate and the card never disagree about a stop', () => {
    for (const [code, entry] of table) {
      const state = syncStopState({ lastError: code, phase: 'error' });
      assert.equal(persistentLocalSyncFailure(code), entry.exit === 'stop', code);
      assert.equal(state?.kind === 'stopped', persistentLocalSyncFailure(code) && !refreshesReplicaIntegrity(code), code);
      assert.equal(state?.kind === 'terminal', syncAttentionTerminalCode(code, undefined) !== undefined, code);
    }
  });

  test('the recorded recovery code freezes alone, and the two codes the table does not list are terminal', () => {
    assert.equal(syncStopState({ recoveryCode: 'mapping_identity_conflict' })?.kind, 'terminal');
    assert.equal(syncStopState({ lastError: 'payload_too_large' })?.kind, 'terminal');
    assert.equal(syncStopState({ lastError: 'replica_rebuild_pending' })?.kind, 'terminal');
  });
});

describe('what the breaker adds', () => {
  const breaker = (...codes: string[]) => ({ failures: codes.map(code => ({ code })), retryAt: NOW + 300_000 });

  test('a code that kept coming back with no progress is stalled, once the engine recorded the stall for that code', () => {
    const waiting = { lastError: 'session_handoff_pending', phase: 'error' };
    assert.deepEqual(syncStopState({ ...waiting, breaker: breaker(`${STALLED_BUCKET_PREFIX}session_handoff_pending`) }),
      { kind: 'stalled', code: 'session_handoff_pending' });
    assert.equal(syncStopState({ ...waiting, breaker: breaker(`${STALLED_BUCKET_PREFIX}another_code`) })?.kind, 'cooling', 'another code stalled');
    assert.equal(syncStopState({ ...waiting, phase: 'sleeping', breaker: breaker(`${STALLED_BUCKET_PREFIX}session_handoff_pending`) }), undefined,
      'the engine moved on');
  });

  test('a stop keeps its kind with or without a probe scheduled', () => {
    const stop = { lastError: 'queue_state_invalid', phase: 'error' };
    assert.equal(syncStopState({ ...stop, breaker: breaker(`${STOP_BUCKET_PREFIX}queue_state_invalid`) })?.kind, 'stopped');
    assert.equal(syncStopState(stop)?.kind, 'stopped', 'written before probes existed');
  });

  test('a paused breaker on a code that heals is a cooldown; a Pull-time integrity stop is neither', () => {
    assert.equal(syncStopState({ lastError: 'stale_replica', phase: 'error', breaker: breaker('stale_replica') })?.kind, 'cooling');
    assert.equal(syncStopState({ lastError: 'pull_page_invalid', phase: 'error', breaker: breaker('replica_integrity_refresh') }), undefined);
    assert.equal(syncStopState({ lastError: 'network_unavailable', phase: 'error' }), undefined, 'backing off, not paused');
  });
});

describe('the card, the chip and the copied details say the same', () => {
  const scope = { environment: 'production', serverId: 's', serverOrigin: 'https://known.example', accountId: 'a',
    browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 } as SyncScope;
  const open = { bootstrap: [], operationalTotal: 0, queue: [], pull: [], local: [], replica: [], waits: [], deletes: [],
    roots: new Set<string>(), nativeRoots: new Set<string>(), total: 0 } as never;

  async function both(engine: Record<string, unknown> | undefined, recoveryCode?: string) {
    const store = { getScope: async () => ({ firstRun: 'completed', ...(recoveryCode ? { metadata: { recoveryCode } } : {}) }),
      getEngineState: async () => engine, listQueue: async () => [], listBootstrapRuns: async () => [], getRecoveryHeader: async () => null,
      listAckIntents: async () => [], listProjectionIntents: async () => [] };
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: store as never, openIssues: open });
    assert.ok(response.ok);
    const attention = response.ok ? response.attention : (undefined as never);
    return { attention, diagnostic: await collectSyncDiagnostics(store as never, scope) };
  }
  const error = (lastError: string, extra: Record<string, unknown> = {}) => ({ phase: 'error', lastError, updatedAt: NOW,
    recoveryFrozen: false, authorityRefreshRequired: false, notBefore: NOW + 300_000, ...extra });

  test('a freeze recorded only as a recovery code is terminal in both (the diagnostic used to need recoveryFrozen)', async () => {
    const { attention, diagnostic } = await both({ phase: 'recovery', updatedAt: NOW, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 },
      'mapping_identity_conflict');
    assert.equal(attention.terminal, true);
    assert.equal(attention.retryAutomatic, false);
    assert.equal(diagnostic.engine.retryAutomatic, false);
    assert.equal(diagnostic.engine.stop, 'terminal');
  });

  test('a stop with a probe: the card says it checks again at retryAt; the diagnostic names the kind', async () => {
    const engine = error('queue_state_invalid', { circuitBreaker: { progress: 'p', trips: 0, retryAt: NOW + 300_000,
      failures: [{ code: `${STOP_BUCKET_PREFIX}queue_state_invalid`, attempts: [NOW] }] } });
    const { attention, diagnostic } = await both(engine);
    assert.equal(attention.stopKind, 'stopped');
    assert.equal(attention.coolingDown, undefined);
    assert.equal(attention.retryAt, NOW + 300_000);
    assert.equal(attention.terminal, false);
    assert.deepEqual([diagnostic.engine.stop, diagnostic.engine.retryAutomatic], ['stopped', false]);
  });

  test('a stalled wait, a cooldown and a calm engine', async () => {
    const stalled = await both(error('session_handoff_pending', { circuitBreaker: { progress: 'p', trips: 0, retryAt: NOW + 300_000,
      failures: [{ code: `${STALLED_BUCKET_PREFIX}session_handoff_pending`, attempts: [NOW] }] } }));
    assert.deepEqual([stalled.attention.stopKind, stalled.diagnostic.engine.stop], ['stalled', 'stalled']);
    const cooling = await both(error('stale_replica', { circuitBreaker: { progress: 'p', trips: 2, retryAt: NOW + 300_000, failures: [] } }));
    assert.deepEqual([cooling.attention.coolingDown, cooling.attention.stopKind, cooling.diagnostic.engine.stop], [true, undefined, 'cooling']);
    const calm = await both({ phase: 'sleeping', updatedAt: NOW, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 });
    assert.deepEqual([calm.attention.terminal, calm.attention.stopKind, calm.attention.coolingDown, calm.diagnostic.engine.stop],
      [false, undefined, undefined, null]);
    assert.equal(calm.diagnostic.engine.retryAutomatic, true);
  });

  test('every table entry: the card\'s terminal flag is the diagnostic\'s, and retryAutomatic is the same fact', async () => {
    const mismatches: string[] = [];
    for (const [code] of table) {
      const { attention, diagnostic } = await both(error(code));
      if (attention.terminal !== (diagnostic.engine.stop === 'terminal')) mismatches.push(`${code}: terminal`);
      if (attention.retryAutomatic !== diagnostic.engine.retryAutomatic) mismatches.push(`${code}: retryAutomatic`);
      if ((attention.stopKind ?? null) !== (diagnostic.engine.stop === 'stopped' || diagnostic.engine.stop === 'stalled' ? diagnostic.engine.stop : null)) {
        mismatches.push(`${code}: stopKind`);
      }
    }
    assert.deepEqual(mismatches, []);
  });
});
