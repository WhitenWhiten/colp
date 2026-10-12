import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  canContinueIndependentPull, classifyMountActivity, compareRejoinFacts, decideRangeTransition,
  isWritableActiveScope, rejoinCommandInFlight,
} from '../src/scope-transition.js';

const fixture = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/range-transition-contract.json'), 'utf8',
)) as {
  readonly rows: ReadonlyArray<{
    readonly id: string; readonly source: string; readonly destination: string;
    readonly identityConfirmed?: boolean; readonly ancestorConfirmed?: boolean;
    readonly permissionConfirmed?: boolean; readonly pendingLocalOperations?: boolean;
    readonly action: string; readonly chromeMutation: boolean;
  }>;
};

describe('S-01 range transition contract', () => {
  test('FRR-01-A: conversion table matches Chrome mutation and mapping actions', () => {
    for (const row of fixture.rows) {
      const decision = decideRangeTransition({
        source: { kind: row.source as 'active' }, destination: { kind: row.destination as 'active' },
        identityConfirmed: row.identityConfirmed !== false, ancestorConfirmed: row.ancestorConfirmed !== false,
        permissionConfirmed: row.permissionConfirmed !== false,
        pendingLocalOperations: row.pendingLocalOperations === true,
      });
      assert.equal(decision.action, row.action, row.id);
      assert.equal(decision.chromeMutation, row.chromeMutation, row.id);
      if (row.pendingLocalOperations) assert.equal(decision.preservePendingOperations, true, row.id);
    }
  });

  test('detached→active materialize persists a range-exit exclusion', () => {
    const decision = decideRangeTransition({
      source: { kind: 'detached' }, destination: { kind: 'active' },
      identityConfirmed: true, ancestorConfirmed: true, permissionConfirmed: true,
    });
    assert.equal(decision.action, 'materialize_independent');
    assert.equal(decision.persistExclusion, true);
    assert.equal(decision.chromeMutation, true);
    assert.equal(decision.persistObservation, true);
  });

  test('status !== detached is not writable-active', () => {
    assert.equal(isWritableActiveScope({ status: 'pending' }), false);
    assert.equal(isWritableActiveScope({ status: 'active', rejoinInFlight: true }), false);
    assert.equal(isWritableActiveScope({ status: 'active', privateLocal: true }), false);
    assert.equal(isWritableActiveScope({ status: 'active', identityKnown: false }), false);
    assert.equal(classifyMountActivity({ status: 'active' }), 'active');
    assert.equal(isWritableActiveScope({ status: 'active' }), true);
  });

  test('rejoin command phases distinguish in-flight work from terminal active/failed', () => {
    assert.equal(rejoinCommandInFlight('comparing'), true);
    assert.equal(rejoinCommandInFlight('applying'), true);
    assert.equal(rejoinCommandInFlight('pending'), true);
    assert.equal(rejoinCommandInFlight('active'), false);
    assert.equal(rejoinCommandInFlight('failed'), false);
  });

  test('FRR-02 triple comparison', () => {
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: true, remoteEqualsBaseline: false,
      sameFieldFork: false, bothChangedDistinctFields: false, remoteDeleted: false, localEdited: false,
    }), 'apply_remote');
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: false, remoteEqualsBaseline: true,
      sameFieldFork: false, bothChangedDistinctFields: false, remoteDeleted: false, localEdited: true,
    }), 'queue_local_at_baseline_revision');
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: false, remoteEqualsBaseline: false,
      sameFieldFork: false, bothChangedDistinctFields: true, remoteDeleted: false, localEdited: true,
    }), 'typed_merge');
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: false, remoteEqualsBaseline: false,
      sameFieldFork: true, bothChangedDistinctFields: false, remoteDeleted: false, localEdited: true,
    }), 'conflict');
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: true, remoteEqualsBaseline: false,
      sameFieldFork: false, bothChangedDistinctFields: false, remoteDeleted: true, localEdited: false,
    }), 'apply_delete_policy');
    assert.equal(compareRejoinFacts({
      baselineKnown: true, localEqualsBaseline: false, remoteEqualsBaseline: false,
      sameFieldFork: false, bothChangedDistinctFields: false, remoteDeleted: true, localEdited: true,
    }), 'retain_local_edit');
    assert.equal(compareRejoinFacts({
      baselineKnown: false, localEqualsBaseline: false, remoteEqualsBaseline: false,
      sameFieldFork: false, bothChangedDistinctFields: false, remoteDeleted: false, localEdited: false,
    }), 'baseline_unknown');
  });

  test('legal duplicates continue; unknown side effects stay blocked', () => {
    assert.equal(canContinueIndependentPull({
      unknownBrowserSideEffect: false, legalDuplicateContent: true, sharesParentChild: false,
      sharesNode: false, sharesPlacementAnchor: false, sharesParentChildrenRevision: false,
    }), 'continue');
    assert.equal(canContinueIndependentPull({
      unknownBrowserSideEffect: true, legalDuplicateContent: false, sharesParentChild: false,
      sharesNode: false, sharesPlacementAnchor: false, sharesParentChildrenRevision: false,
    }), 'unknown_side_effect');
    assert.equal(canContinueIndependentPull({
      unknownBrowserSideEffect: false, legalDuplicateContent: false, sharesParentChild: true,
      sharesNode: false, sharesPlacementAnchor: false, sharesParentChildrenRevision: false,
    }), 'block');
  });
});
