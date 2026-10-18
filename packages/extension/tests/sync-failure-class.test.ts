import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import {
  SYNC_FAILURE_TABLE, classifySyncFailure, freezesPullApply, holdsInboundPull, holdsUnprovenIdentity,
  needsReplicaRebuild, persistentLocalSyncFailure,
} from '../src/sync-failure-class.js';

/**
 * The five lists the classifier replaced, as they were. The derived behaviour
 * must not move for any code they named; the table is where a new code is
 * classified on purpose.
 */
const FORMER = {
  freeze: ['pull_page_invalid', 'effect_page_invalid', 'pull_event_duplicate', 'pull_effect_binding_invalid',
    'pull_effect_kind_invalid', 'pull_cursor_chain_invalid', 'pull_source_binding_invalid', 'unexpected_effect_page',
    'anchor_parent_mismatch', 'snapshot_expired', 'sync_cursor_expired', 'effect_page_transport_unavailable',
    'effect_page_failed', 'snapshot_page_missing', 'deletion_identity_unproven', 'recovery_identity_unproven',
    'remote_delete_confirmation_required', 'need_authority', 'unmounted_restore_repair', 'mapping_identity_collision',
    'create_ambiguous', 'create_evidence_missing', 'pull_page_reuse', 'recovery_required',
    'recovery_capability_premature', 'recovery_capability_invalid', 'recovery_authority_invalid', 'pull_event_conflict',
    'pull_apply_target_missing', 'pull_apply_evidence_missing', 'legacy_resolution_sequence_collision',
    'snapshot_409_sync_cursor_expired', 'preflight_parent_mapping_missing', 'mapping_missing_parent',
    'anchor_mapping_missing', 'target_mapping_missing'],
  unprovenIdentity: ['recovery_identity_unproven', 'deletion_identity_unproven', 'create_placement_parent_deleted',
    'create_placement_unproven'],
  rebuild: ['pull_apply_target_missing', 'pull_apply_evidence_missing', 'anchor_mapping_missing',
    'legacy_resolution_sequence_collision', 'metadata_sync_disabled', 'mapping_identity_collision', 'create_ambiguous',
    'create_evidence_missing'],
  persistent: ['bounded_string_invalid', 'secret_field_forbidden', 'i_json_invalid', 'record_too_large',
    'snapshot_projection_incomplete', 'operation_schema_invalid'],
  pullsOnWake: ['network_unavailable', 'position_context_stale', 'revision_conflict'],
} as const;

describe('sync failure classifier', () => {
  const codes = [...new Set([...Object.values(FORMER).flat(), ...Object.keys(SYNC_FAILURE_TABLE)])];

  test.each(codes)('%s keeps the behaviour of the lists it replaced', (code) => {
    assert.equal(freezesPullApply(code), (FORMER.freeze as readonly string[]).includes(code), 'freezes Pull');
    assert.equal(holdsUnprovenIdentity(code), (FORMER.unprovenIdentity as readonly string[]).includes(code), 'identity gate');
    // payload_too_large always had its own terminal check next to the rebuild exit.
    assert.equal(needsReplicaRebuild(code),
      (FORMER.rebuild as readonly string[]).includes(code) || code === 'payload_too_large', 'rebuild exit');
    assert.equal(persistentLocalSyncFailure(code), (FORMER.persistent as readonly string[]).includes(code), 'stop');
    assert.equal(holdsInboundPull(code), !(FORMER.pullsOnWake as readonly string[]).includes(code), 'inbound Pull');
  });

  test('every code the extension records as a stop, a freeze or a terminal reason is classified', () => {
    const recorded = new Set<string>();
    for (const file of sourceFiles(join(import.meta.dirname, '../src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/freezeScopeRecovery\([^;]*?'([a-z][a-z0-9_]*)'/gsu)) recorded.add(match[1]!);
    }
    const types = readFileSync(join(import.meta.dirname, '../src/types.ts'), 'utf8');
    const terminal = /export type SyncAttentionTerminalCode = ([^;]+);/u.exec(types)?.[1] ?? '';
    for (const match of terminal.matchAll(/'([a-z][a-z0-9_]*)'/gu)) recorded.add(match[1]!);
    recorded.delete('replica_rebuild_pending');
    assert.ok(recorded.size > 10);
    assert.deepEqual([...recorded].filter((code) => classifySyncFailure(code) === undefined), []);
  });

  test('a code nobody classified has no entry, so it gets bounded retries instead of a silent class', () => {
    assert.equal(classifySyncFailure('brand_new_failure'), undefined);
    assert.equal(freezesPullApply('brand_new_failure'), false);
    assert.equal(holdsInboundPull('brand_new_failure'), true);
    assert.equal(holdsInboundPull(undefined), false);
  });

  test('every class and exit in the table is one the engine knows', () => {
    for (const [code, value] of Object.entries(SYNC_FAILURE_TABLE)) {
      assert.ok(['transient', 'authority', 'item', 'replica'].includes(value.class), code);
      assert.ok(['retry', 'refresh', 'decide', 'confirm', 'rebuild', 'stop'].includes(value.exit), code);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}
