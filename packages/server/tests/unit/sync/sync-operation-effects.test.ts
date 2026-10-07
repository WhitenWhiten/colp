import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import {
  buildAuthoritativeEffectPages,
  validatePersistedAuthoritativeEffect,
} from '../../../src/modules/sync/sync-operation-effects.js';

const operation = Object.freeze({
  opId: 'op-create', replicaId: 'replica-a', sequence: 7, collectionId: 'collection-a',
  baseRevision: null, occurredAt: '2026-07-27T00:00:00Z',
  type: 'create_node', payload: {
    node: { kind: 'bookmark', title: 'Known', url: 'https://example.test' }, parentId: 'root',
  },
} as unknown as Operation);

describe('P3-32B authoritative effect integrity', () => {
  test('accepts one immutable source-bound effect and rejects tamper, wrong binding and duplicates', () => {
    const effect = {
      effectId: 'effect-create', opId: operation.opId, replicaId: operation.replicaId,
      sequence: operation.sequence, collectionId: operation.collectionId, status: 'applied',
      operationDigest: '', effectDigest: '', kind: 'node_created',
      node: { id: 'server-node', collectionId: 'collection-a', kind: 'bookmark', title: 'Known',
        url: 'https://example.test', tags: [], extensions: {}, createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        parentId: 'root', position: 'a', revision: 'revision-2' },
      placement: { parentId: 'root', afterId: null, beforeId: null, position: 'a' },
      parentRevision: { parentId: 'root', childrenRevision: 'children-2' },
      nodeChildrenRevision: null,
    };
    const valid = validatePersistedAuthoritativeEffect({ operation, effect, cursor: 'cursor-1' });
    assert.equal(valid.kind, 'node_created');
    assert.throws(() => validatePersistedAuthoritativeEffect({ operation,
      effect: { ...valid, opId: 'wrong' }, cursor: 'cursor-1' }), /integrity/i);
    assert.throws(() => validatePersistedAuthoritativeEffect({ operation,
      effect: { ...valid, effectDigest: valid.operationDigest }, cursor: 'cursor-1' }), /integrity/i);
  });

  test('binds every effect to the exact Operation lane tuple (replicaId and Sequence)', () => {
    const effect = {
      effectId: 'effect-lane', opId: operation.opId, replicaId: operation.replicaId,
      sequence: operation.sequence, collectionId: operation.collectionId, status: 'applied',
      operationDigest: '', effectDigest: '', kind: 'node_created',
      node: { id: 'server-node', collectionId: 'collection-a', kind: 'bookmark', title: 'Known',
        url: 'https://example.test', tags: [], extensions: {}, createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z', parentId: 'root', position: 'a', revision: 'revision-2' },
      placement: { parentId: 'root', afterId: null, beforeId: null, position: 'a' },
      parentRevision: { parentId: 'root', childrenRevision: 'children-2' },
      nodeChildrenRevision: null,
    };
    const valid = validatePersistedAuthoritativeEffect({ operation, effect, cursor: 'cursor-lane' });
    assert.equal(valid.replicaId, operation.replicaId);
    assert.equal(valid.sequence, operation.sequence);
    for (const tampered of [
      { ...valid, sequence: valid.sequence + 1 },
      { ...valid, replicaId: 'replica-b' },
    ]) {
      assert.throws(() => validatePersistedAuthoritativeEffect({
        operation, effect: tampered, cursor: 'cursor-lane',
      }), /integrity/i);
    }
  });

  test('partitions large subtree membership into a complete stable digest chain', () => {
    const members = Array.from({ length: 513 }, (_, index) => `node-${index}`);
    const pages = buildAuthoritativeEffectPages('effect-subtree', members, { maxMembersPerPage: 64 });
    assert.equal(pages.length, 9);
    assert.equal(pages.flatMap((page) => page.members).length, members.length);
    assert.equal(pages[0]!.previousPageDigest, null);
    for (let index = 1; index < pages.length; index += 1) {
      assert.equal(pages[index]!.previousPageDigest, pages[index - 1]!.pageDigest);
      assert.equal(pages[index]!.pageNumber, index + 1);
      assert.equal(pages[index]!.pageCount, pages.length);
    }
    const replay = buildAuthoritativeEffectPages('effect-subtree', members, { maxMembersPerPage: 64 });
    assert.deepEqual(replay, pages);
  });

  test('fails closed for duplicate members and invalid page budgets', () => {
    assert.throws(() => buildAuthoritativeEffectPages('effect-subtree', ['a', 'a']), /duplicate/i);
    assert.throws(() => buildAuthoritativeEffectPages('effect-subtree', ['a'], { maxMembersPerPage: 0 }), /budget/i);
  });
});
