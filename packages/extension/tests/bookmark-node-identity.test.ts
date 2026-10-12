import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  classifyDeletionScope, classifyObservedNative, identityFromMapping, type NodeIdentity,
} from '../src/bookmark-node-identity.js';

const identity = (colpId: string): NodeIdentity => ({
  nativeId: 'n1', colpId, rootNativeId: 'root', revision: 'r1', content: { title: 'T' },
});

describe('classifyObservedNative', () => {
  test('mapped authoritative identity wins over firstRun completed', () => {
    const decision = classifyObservedNative({
      generation: 1, firstRun: 'completed', mapping: identity('colp-1'), underSelectedMount: true,
    });
    assert.equal(decision.kind, 'mapped');
  });

  test('pending create is reused before inventing a second node', () => {
    const decision = classifyObservedNative({
      generation: 1, firstRun: 'completed', pendingCreate: { eventId: 'e1', identity: identity('pending-e1') },
      underSelectedMount: true,
    });
    assert.equal(decision.kind, 'pending_create');
    if (decision.kind === 'pending_create') assert.equal(decision.eventId, 'e1');
  });

  test('terminal receipt without mapping restores the same remote id', () => {
    const decision = classifyObservedNative({
      generation: 1, firstRun: 'completed', receiptIdentity: identity('remote-1'), underSelectedMount: true,
    });
    assert.equal(decision.kind, 'receipt_unbound');
  });

  test('running bootstrap owns unmapped natives instead of a second create', () => {
    const decision = classifyObservedNative({
      generation: 1, firstRun: 'running', underSelectedMount: true,
    });
    assert.equal(decision.kind, 'bootstrap_owned');
  });

  test('completed first-run with no upload evidence is a new local capture', () => {
    const decision = classifyObservedNative({
      generation: 1, firstRun: 'completed', underSelectedMount: true,
    });
    assert.equal(decision.kind, 'new_local');
  });

  test('same native string across generations is not reused', () => {
    const decision = classifyObservedNative({
      generation: 2, observedGeneration: 1, firstRun: 'completed', mapping: identity('colp-old'),
      underSelectedMount: true,
    });
    assert.deepEqual(decision, { kind: 'needs_attention', reason: 'generation_mismatch' });
  });

  test('identityFromMapping copies durable projection fields', () => {
    const copied = identityFromMapping({
      nativeId: 'n', colpId: 'c', rootNativeId: 'r', nodeKind: 'bookmark', parentNativeId: 'p',
      projection: { revision: 'rev', childrenRevision: 'ch', digest: 'sha256:x', content: { title: 'A' } },
    });
    assert.equal(copied.childrenRevision, 'ch');
    assert.equal(copied.parentNativeId, 'p');
  });
});

describe('classifyDeletionScope', () => {
  test('unselected parent is filtered without freeze', () => {
    assert.deepEqual(classifyDeletionScope({
      managed: false, ancestorWalkFailed: false, selectedAncestor: false, privateAncestor: false,
      detachedMount: false, hasInScopeMapping: false,
    }), { kind: 'out_of_scope', reason: 'unselected' });
  });

  test('private and managed are out of scope', () => {
    assert.equal(classifyDeletionScope({
      managed: true, ancestorWalkFailed: false, selectedAncestor: true, privateAncestor: false,
      detachedMount: false, hasInScopeMapping: false,
    }).kind, 'out_of_scope');
    assert.deepEqual(classifyDeletionScope({
      managed: false, ancestorWalkFailed: false, selectedAncestor: false, privateAncestor: true,
      detachedMount: false, hasInScopeMapping: false,
    }), { kind: 'out_of_scope', reason: 'private_local' });
  });

  test('in-scope mapping or selected ancestor is in scope', () => {
    assert.equal(classifyDeletionScope({
      managed: false, ancestorWalkFailed: true, selectedAncestor: false, privateAncestor: false,
      detachedMount: false, hasInScopeMapping: true,
    }).kind, 'in_scope');
    assert.equal(classifyDeletionScope({
      managed: false, ancestorWalkFailed: false, selectedAncestor: true, privateAncestor: false,
      detachedMount: false, hasInScopeMapping: false,
    }).kind, 'in_scope');
  });

  test('failed ancestor walk without mapping fails closed', () => {
    assert.deepEqual(classifyDeletionScope({
      managed: false, ancestorWalkFailed: true, selectedAncestor: false, privateAncestor: false,
      detachedMount: false, hasInScopeMapping: false,
    }), { kind: 'unknown' });
  });
});
