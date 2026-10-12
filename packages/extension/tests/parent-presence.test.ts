import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { classifyParentPresence } from '../src/parent-presence.js';

describe('C-05 missing parent is not proven unmounted', () => {
  test('unknown parent identity needs authority and must not Ack as skip_unmounted', () => {
    const result = classifyParentPresence({
      parentIdentityKnown: false, parentProvenInactive: false, parentProvenUnmounted: false,
      sourceRetainedNative: false,
    });
    assert.equal(result, 'need_authority');
    assert.notEqual(result, 'proven_unmounted');
    assert.notEqual(result, 'skip_unmounted');
  });

  test('proven inactive remote is observation-only', () => {
    assert.equal(classifyParentPresence({
      parentIdentityKnown: true, parentProvenInactive: true, parentProvenUnmounted: false,
      sourceRetainedNative: false,
    }), 'observe_inactive');
  });

  test('source-side retained native stays an exclusion, not an active remote upload', () => {
    assert.equal(classifyParentPresence({
      parentIdentityKnown: true, parentProvenInactive: true, parentProvenUnmounted: false,
      sourceRetainedNative: true,
    }), 'retain_local_exclusion');
  });

  test('only a proven unmounted parent may skip as unmounted', () => {
    assert.equal(classifyParentPresence({
      parentIdentityKnown: true, parentProvenInactive: false, parentProvenUnmounted: true,
      sourceRetainedNative: false,
    }), 'proven_unmounted');
  });
});
