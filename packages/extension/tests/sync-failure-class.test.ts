import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, test } from 'vitest';
import { SYNC_FAILURE_TABLE, classifySyncFailure, freezesPullApply, holdsInboundPull, holdsUnprovenIdentity,
  needsReplicaRebuild, persistentLocalSyncFailure, setsAsidePullItem, SyncFailureError,
  PULL_MAPPING_FAILURE, PULL_PREFLIGHT_FAILURE } from '../src/sync-failure-class.js';

describe('registered sync failure policies', () => {
  test('all static error emissions at sync and durable-store boundaries have an explicit policy', () => {
    const root = join(import.meta.dirname, '../src');
    const files = readdirSync(root).filter(name => /^(?:pull-|effect-page|durable-sync-engine|outbound-push|snapshot|recovery|native-)/u.test(name)
      && name.endsWith('.ts')).map(name => join(root, name));
    files.push(...readdirSync(join(root, 'sync-state')).filter(name => name.endsWith('.ts')).map(name => join(root, 'sync-state', name)));
    const emitted = new Set<string>(); const unregistered: string[] = []; const untyped: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && ['Error', 'SyncStateError', 'SyncFailureError'].includes(node.expression.getText(source))) {
          const code = node.arguments?.[0];
          // Parse syntax nodes, including returned errors and non-freeze paths.
          // Dynamic browser/server messages are external inputs, not a closed local code registry.
          if (code && ts.isStringLiteralLike(code) && /^[a-z][a-z0-9_:-]*$/u.test(code.text)) {
            emitted.add(code.text);
            if (!classifySyncFailure(code.text)) unregistered.push(`${file}:${code.text}`);
            if (node.expression.getText(source) === 'Error') untyped.push(`${file}:${code.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.ok(emitted.size > 250, 'audit all local sync/store error constructors, not selected freeze calls');
    assert.deepEqual(unregistered, []); assert.deepEqual(untyped, []);
  });

  test('all finite Pull mapping roles use registered codes with the same staging/apply policy', () => {
    for (const code of Object.values(PULL_MAPPING_FAILURE)) {
      assert.equal(setsAsidePullItem(code, { nodeId: 'node' }), true);
    }
    for (const code of Object.values(PULL_PREFLIGHT_FAILURE)) {
      const policy = classifySyncFailure(code, { nodeId: 'node' });
      assert.equal(policy?.class, 'item'); assert.equal(policy?.stagesAsItem, true); assert.equal(policy?.setsAsidePull, true);
    }
    for (const code of ['preflight_integrity_corrupt', 'not_really_mapping_missing', 'mapping_missing_everything']) {
      assert.equal(classifySyncFailure(code), undefined, 'no string-prefix item privilege');
    }
  });

  test('a failure has item scope only with a concrete subject and a safe apply boundary', () => {
    const code = 'anchor_mapping_missing';
    assert.equal(classifySyncFailure(code)?.class, 'replica');
    assert.equal(classifySyncFailure(code, {})?.class, 'replica');
    assert.equal(classifySyncFailure(code, { nodeId: 'node' })?.class, 'item');
    assert.equal(setsAsidePullItem(code, { nodeId: 'node' }), true);
    assert.equal(setsAsidePullItem('pull_page_invalid', { nodeId: 'node' }), false);
    assert.equal(classifySyncFailure('record_too_large', { opId: 'op' })?.class, 'item');
    assert.equal(classifySyncFailure('record_too_large')?.class, 'replica');
    assert.equal(new SyncFailureError('anchor_mapping_missing', { nodeId: 'node' }).code, code);
  });

  test('integrity failures are never item failures and keep the page fail-closed', () => {
    for (const code of ['pull_page_invalid', 'pull_event_duplicate', 'pull_effect_binding_invalid',
      'pull_cursor_chain_invalid', 'pull_source_binding_invalid', 'unexpected_effect_page']) {
      assert.equal(classifySyncFailure(code, { nodeId: 'node' })?.class, 'replica');
      assert.equal(freezesPullApply(code), true);
      assert.equal(setsAsidePullItem(code, { nodeId: 'node' }), false);
    }
    assert.equal(classifySyncFailure('anchor_parent_mismatch')?.stagesAsItem, undefined);
    assert.equal(classifySyncFailure('snapshot_409_sync_cursor_expired')?.class, 'authority');
    assert.equal(classifySyncFailure('snapshot_409_snapshot_expired')?.class, 'authority');
    assert.equal(freezesPullApply('snapshot_409_snapshot_expired'), true);
    assert.equal(classifySyncFailure('arbitrary_snapshot_expired'), undefined);
    assert.equal(classifySyncFailure('arbitrary_sync_cursor_expired'), undefined);
  });

  test('engine gates and repair exits derive from the registered policy', () => {
    assert.equal(holdsUnprovenIdentity('recovery_identity_unproven'), true);
    assert.equal(needsReplicaRebuild('pull_issue_ceiling'), true);
    assert.equal(persistentLocalSyncFailure('record_too_large'), true);
    assert.equal(classifySyncFailure('delete_journal_invalid')?.class, 'replica');
    assert.equal(persistentLocalSyncFailure('delete_journal_invalid'), true);
    assert.equal(freezesPullApply('delete_journal_invalid'), true);
    assert.equal(holdsInboundPull('network_unavailable'), false);
    assert.equal(holdsInboundPull(undefined), false);
    assert.equal(classifySyncFailure('engine_revision_stale')?.class, 'transient');
  });

  test('unrecognized external codes retain an unknown classification for the engine breaker', () => {
    assert.equal(classifySyncFailure('brand_new_failure'), undefined);
    assert.equal(freezesPullApply('brand_new_failure'), false);
    assert.equal(holdsInboundPull('brand_new_failure'), true);
    // The engine's circuit breaker owns retry accounting. Classification
    // boundaries are exercised by engine and mutation-recovery integration tests.
  });

  test('every registered entry uses supported classes and exits', () => {
    for (const [code, value] of Object.entries(SYNC_FAILURE_TABLE)) {
      assert.ok(['transient', 'authority', 'item', 'replica'].includes(value.class), code);
      assert.ok(['retry', 'refresh', 'decide', 'confirm', 'rebuild', 'stop'].includes(value.exit), code);
    }
  });
});
