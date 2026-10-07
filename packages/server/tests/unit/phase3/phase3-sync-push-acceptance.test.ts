import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  P3_16_PUSH_ACCEPTANCE_SCENARIOS,
  collectPhase3SyncPushScenarioEvidence,
  validatePhase3SyncPushAcceptanceEvidence,
} from '../../../scripts/acceptance/phase3-sync-push-acceptance.js';

describe('P3-16 fail-closed Sync Push acceptance contract', () => {
  test('requires every P3-10 through P3-15 black-box and Sequence lifecycle scenario', () => {
    assert.deepEqual(P3_16_PUSH_ACCEPTANCE_SCENARIOS, [
      'create_folder', 'create_bookmark', 'create_separator', 'typed_update', 'move', 'delete',
      'terminal_exact_replay', 'deferred_exact_replay', 'deferred_recovery',
      'deferred_digest_reuse_rejected', 'sequence_gap', 'sequence_blocked',
      'receipt_missing_fail_closed', 'restart_replay', 'independent_replica_scope',
      'cross_scope_op_id_rejected', 'database_timeout', 'database_deadlock',
      'commit_outcome_unknown_same_request', 'field_exact_replay',
      'single_sequence_owner', 'manifest_sync_unclaimed',
    ]);
    assert.throws(() => validatePhase3SyncPushAcceptanceEvidence({
      sourceCommit: 'a'.repeat(40), sourceTreeDigest: 'b'.repeat(64),
      migration: '202607251900_sync_node_tombstones',
      profileClaimed: false, deploymentProven: false, runtimeRouteDiscovered: true, scenarios: {},
    }), /missing|failed/iu);
    assert.throws(() => validatePhase3SyncPushAcceptanceEvidence({
      sourceCommit: 'a'.repeat(40), sourceTreeDigest: 'b'.repeat(64),
      migration: '202607251900_sync_node_tombstones',
      profileClaimed: false, deploymentProven: false, runtimeRouteDiscovered: false, scenarios: {},
    }), /route/iu);
    assert.throws(() => validatePhase3SyncPushAcceptanceEvidence({
      sourceCommit: 'a'.repeat(40), sourceTreeDigest: 'not-a-digest',
      migration: '202607251900_sync_node_tombstones', profileClaimed: false,
      deploymentProven: false, runtimeRouteDiscovered: true, scenarios: {},
    }), /tree digest/iu);
  });

  test('runner is fail closed and cannot promote sync or deployment evidence', () => {
    const runner = readFileSync(resolve('scripts/phase3-sync-push-acceptance.mjs'), 'utf8');
    const adapter = readFileSync(resolve('scripts/phase3-sync-push-acceptance-adapter.ts'), 'utf8');
    assert.match(runner, /FAIL-CLOSED/u);
    assert.match(runner, /DATABASE_URL is required/u);
    assert.match(adapter, /createSyncSessionBlackBoxClient/u);
    assert.match(adapter, /createPostgresSyncPushApplication/u);
    assert.match(adapter, /runMigrations/u);
    assert.doesNotMatch(`${runner}\n${adapter}`, /profileClaimed:\s*true/u);
    assert.doesNotMatch(`${runner}\n${adapter}`, /deploymentProven:\s*true/u);
    assert.doesNotMatch(adapter,
      /P3_16_PUSH_ACCEPTANCE_SCENARIOS\.map\([\s\S]*?\[scenario,\s*true\]/u);
  });

  test('accepts only nonce-bound scenario records emitted by the executing test process', () => {
    const nonce = 'acceptance-run-nonce';
    const records = P3_16_PUSH_ACCEPTANCE_SCENARIOS.map((scenario) => ({
      scenario, nonce, boundary: 'real_http_postgres' as const,
    }));
    assert.deepEqual(collectPhase3SyncPushScenarioEvidence(records, nonce),
      Object.fromEntries(P3_16_PUSH_ACCEPTANCE_SCENARIOS.map((scenario) => [scenario, true])));
    assert.throws(() => collectPhase3SyncPushScenarioEvidence(records.slice(1), nonce), /missing/iu);
    assert.throws(() => collectPhase3SyncPushScenarioEvidence([
      ...records.slice(0, -1), { ...records.at(-1)!, nonce: 'stale-run' },
    ], nonce), /nonce|missing/iu);
    assert.throws(() => collectPhase3SyncPushScenarioEvidence([
      ...records.slice(0, -1), { ...records.at(-1)!, boundary: 'unit' as never },
    ], nonce), /boundary/iu);
  });
});
