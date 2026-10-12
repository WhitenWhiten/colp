/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync/canonical';
import { assertUniqueEvents, byteLength, digest, plainJson, record, stable,
  validateEffectPages, validatePullEvent } from '../src/pull-codec.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const collectionId = 'collection-codec';

describe('Pull protocol codec', () => {
  test('keeps the browser-safe canonical digest stable across object key order', () => {
    const expected = 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777';
    assert.equal(stable({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(digest({ b: 2, a: 1 }), expected);
    assert.equal(digest({ a: 1, b: 2 }), expected);
    assert.equal(byteLength({ emoji: '好' }), new TextEncoder().encode('{"emoji":"好"}').byteLength);
    assert.equal(record({}), true); assert.equal(record([]), false); assert.equal(record(null), false);
    assert.throws(() => stable(undefined), /i_json_invalid/);
  });

  test('takes a detached plain JSON copy without retaining extension references', () => {
    const input = { nested: { value: 1 } };
    const copy = plainJson(input);
    input.nested.value = 2;
    assert.deepEqual(copy, { nested: { value: 1 } });
  });

  test('accepts every authoritative effect family and conflicts', () => {
    const events = [
      pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId, parentId: 'root' }),
      pullFixtures.mutationEvent({ kind: 'update', sequence: 2, collectionId, targetId: 'node', parentId: 'root' }),
      pullFixtures.mutationEvent({ kind: 'move', sequence: 3, collectionId, targetId: 'node', parentId: 'root' }),
      pullFixtures.mutationEvent({ kind: 'delete', sequence: 4, collectionId, targetId: 'node', parentId: 'root' }),
      pullFixtures.subtreeEvent({ sequence: 5, collectionId, targetId: 'node', members: ['node'], paged: false }),
      pullFixtures.restoreEvent({ sequence: 6, collectionId, targetId: 'node', parentId: 'root' }),
    ];
    for (const event of events) assert.equal(validatePullEvent(event), event);
    const conflict = { cursor: 'cursor-conflict', kind: 'conflict', conflict: {
      id: 'conflict-1', collectionId, targetId: 'node', type: 'content', createdAt: '2026-09-01T00:00:00.000Z',
      status: 'open', allowedResolutions: ['server'], revision: 'revision-conflict',
    } } as SyncPullEventV02;
    assert.equal(validatePullEvent(conflict), conflict);
  });

  test.each([
    ['create', () => pullFixtures.createEvent({ kind: 'Folder', sequence: 11, collectionId, parentId: 'root' }),
      (event: any) => { event.effect.nodeChildrenRevision = null; }],
    ['update', () => pullFixtures.mutationEvent({ kind: 'update', sequence: 12, collectionId,
      targetId: 'node', parentId: 'root' }), (event: any) => { event.effect.node.id = 'other'; }],
    ['move', () => pullFixtures.mutationEvent({ kind: 'move', sequence: 13, collectionId,
      targetId: 'node', parentId: 'root' }), (event: any) => { event.effect.placement.parentId = 'other'; }],
    ['delete', () => pullFixtures.mutationEvent({ kind: 'delete', sequence: 14, collectionId,
      targetId: 'node', parentId: 'root' }), (event: any) => { event.effect.deletion.affectedCount = 2; }],
    ['subtree', () => pullFixtures.subtreeEvent({ sequence: 15, collectionId, targetId: 'node',
      members: ['node'], paged: false }), (event: any) => { event.effect.members.push('other'); }],
    ['restore', () => pullFixtures.restoreEvent({ sequence: 16, collectionId, targetId: 'node', parentId: 'root' }),
      (event: any) => { event.effect.node.id = 'other'; }],
  ])('rejects a bound %s effect mutated after authority digesting', (_kind, create, mutate) => {
    const event: any = structuredClone(create()); mutate(event);
    assert.throws(() => validatePullEvent(event), /pull_effect_binding_invalid/);
  });

  test('rejects duplicate cursor, operation, effect and conflict identities', () => {
    const first = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 21, collectionId, parentId: 'root' });
    const second = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 22, collectionId, parentId: 'root' });
    const firstOperation = first as Extract<SyncPullEventV02, { kind: 'operation' }>;
    assert.doesNotThrow(() => assertUniqueEvents([first, second]));
    assert.throws(() => assertUniqueEvents([first, { ...second, cursor: first.cursor }]), /pull_event_duplicate/);
    assert.throws(() => assertUniqueEvents([first, { ...second, operation: first.operation } as never]),
      /pull_event_duplicate/);
    assert.throws(() => assertUniqueEvents([first, { ...second, effect: {
      ...second.effect, effectId: firstOperation.effect.effectId } } as never]), /pull_event_duplicate/);
    const conflict = (cursor: string) => ({ cursor, kind: 'conflict',
      conflict: { id: 'conflict-duplicate' } } as SyncPullEventV02);
    assert.throws(() => assertUniqueEvents([conflict('conflict-a'), conflict('conflict-b')]),
      /pull_event_duplicate/);
  });

  test('rejects subtree membership that disagrees with the effect after the digest is rewritten', () => {
    const inline: any = structuredClone(pullFixtures.subtreeEvent({
      sequence: 41, collectionId, targetId: 'node', members: ['node'], paged: false,
    }));
    inline.effect.memberDigest = 'sha256:deadbeef';
    inline.effect.effectDigest = canonicalAuthoritativeEffectDigest(inline.effect);
    assert.throws(() => validatePullEvent(inline), /pull_effect_binding_invalid/);
    const paged: any = structuredClone(pullFixtures.subtreeEvent({
      sequence: 42, collectionId, targetId: 'node', members: ['node'], paged: true,
    }));
    paged.effect.effectRef = { ...paged.effect.effectRef, memberDigest: 'sha256:deadbeef' };
    paged.effect.effectDigest = canonicalAuthoritativeEffectDigest(paged.effect);
    assert.throws(() => validatePullEvent(paged), /pull_effect_binding_invalid/);
  });

  test('validates the exact ordered effect-page chain and its aggregate membership', () => {
    const event: any = pullFixtures.subtreeEvent({ sequence: 31, collectionId, targetId: 'node',
      members: ['node', 'child'], paged: true });
    const pages = event.__effectPages;
    const reference = { ...event.effect.effectRef, effectId: event.effect.effectId };
    assert.doesNotThrow(() => validateEffectPages(pages, reference));
    assert.throws(() => validateEffectPages([], reference), /effect_page_invalid/);
    assert.throws(() => validateEffectPages([{ ...pages[0], effectId: 'other' }], reference), /effect_page_invalid/);
    assert.throws(() => validateEffectPages(pages, { ...reference, firstPageDigest: 'sha256:wrong' }),
      /effect_page_invalid/);
    assert.throws(() => validateEffectPages(pages, { ...reference, memberCount: 3 }), /effect_page_invalid/);
  });
});
