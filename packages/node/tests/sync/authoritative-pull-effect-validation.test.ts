import { describe, expect, it, vi } from 'vitest';

import {
  assertAuthoritativeEffectPageUrlSafe,
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  expandAuthoritativeEffectPageUrl,
  validateAuthoritativePullEvent,
  validateAuthoritativePullEventPage,
  validateAuthoritativePullEventPages,
} from '../../src/sync/index.js';

const digestA = `sha-256=:${'A'.repeat(43)}=:`;
const digestB = `sha-256=:${'B'.repeat(43)}=:`;
const operation = {
  opId: 'op-1', replicaId: 'replica-source', sequence: 7, collectionId: 'collection-1',
  type: 'move_node' as const, targetId: 'node-1', baseRevision: 'r-8', occurredAt: '2026-07-27T00:00:00Z',
  payload: { newParentId: 'folder-2', afterId: null, beforeId: 'sibling-1', baseSourceParentRevision: 'cr-7', baseTargetParentRevision: 'cr-11' },
};
const effectInput = {
  effectId: 'effect-1', status: 'rebased' as const, opId: 'op-1', replicaId: 'replica-source', sequence: 7,
  collectionId: 'collection-1', operationDigest: canonicalOperationDigest(operation), effectDigest: digestB, kind: 'node_moved' as const,
  node: { id: 'node-1', collectionId: 'collection-1', kind: 'folder' as const, parentId: 'folder-2', position: 'a', title: 'Moved', createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z', revision: 'r-9' },
  placement: { parentId: 'folder-2', afterId: null, beforeId: 'sibling-1', position: 'a' },
  parentRevisions: [{ parentId: 'folder-1', childrenRevision: 'cr-8' }, { parentId: 'folder-2', childrenRevision: 'cr-12' }],
};
const effect = { ...effectInput, effectDigest: canonicalAuthoritativeEffectDigest(effectInput as never) };

describe('SYNC-0027 runtime authoritative Pull validation', () => {
  it('accepts a member digest at the generic JSON member boundary', () => {
    const members = Array.from({ length: 10_000 }, (_, index) => `node-${index + 1}`);
    expect(canonicalAuthoritativeMemberDigest(members)).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
  });

  it.each([
    'https://sync.example/pages?access_token=secret',
    'https://sync.example/pages?SessionId=secret',
    'https://user:secret@sync.example/pages',
    'https://sync.example/pages#secret',
    'https://localhost/pages',
    'https://127.0.0.1/pages',
    'http://sync.example/pages',
  ])('rejects unsafe effect-page URL %s', (url) => {
    expect(() => assertAuthoritativeEffectPageUrlSafe(url)).toThrow(/credential|private|local/i);
  });

  it('accepts an operation-bound applied/rebased effect', () => {
    expect(validateAuthoritativePullEvent({ cursor: 'receiver-cursor', kind: 'operation', operation, effect } as never, '0.2')).toMatchObject({ kind: 'operation' });
  });

  it('accepts restore_node → node_restored with original id, new revision, and consumed tombstone', () => {
    const restoreOperation = {
      opId: 'op-restore', replicaId: 'replica-source', sequence: 8, collectionId: 'collection-1',
      type: 'restore_node' as const, targetId: 'node-1', baseRevision: 'delete-r-1',
      occurredAt: '2026-07-27T00:00:00Z', payload: { reason: 'restore' },
    };
    const restoreInput = {
      effectId: 'effect-restore', status: 'applied' as const, opId: 'op-restore',
      replicaId: 'replica-source', sequence: 8, collectionId: 'collection-1',
      operationDigest: canonicalOperationDigest(restoreOperation), effectDigest: digestB,
      kind: 'node_restored' as const,
      node: {
        id: 'node-1', collectionId: 'collection-1', kind: 'bookmark' as const, parentId: 'folder-2',
        position: 'a', title: 'Restored', url: 'https://example.com/',
        createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T01:00:00Z', revision: 'r-restore',
      },
      placement: { parentId: 'folder-2', afterId: null, beforeId: null, position: 'a' },
      parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-restore' },
      consumedTombstone: {
        resourceType: 'node' as const, targetId: 'node-1', collectionId: 'collection-1',
        scope: 'single' as const, deletedAt: '2026-07-27T00:00:00Z', deleteRevision: 'delete-r-1',
        operationId: 'op-delete', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z',
        deleteCursor: 'tombstone-cursor-1',
      },
    };
    const restoreEffect = { ...restoreInput, effectDigest: canonicalAuthoritativeEffectDigest(restoreInput as never) };
    expect(validateAuthoritativePullEvent({
      cursor: 'receiver-cursor', kind: 'operation', operation: restoreOperation, effect: restoreEffect,
    } as never, '0.2')).toMatchObject({ kind: 'operation' });
    const staleRevisionInput = {
      ...restoreInput,
      node: { ...restoreInput.node, revision: 'delete-r-1' },
    };
    const staleRevisionEffect = {
      ...staleRevisionInput,
      effectDigest: canonicalAuthoritativeEffectDigest(staleRevisionInput as never),
    };
    expect(() => validateAuthoritativePullEvent({
      cursor: 'receiver-cursor', kind: 'operation', operation: restoreOperation, effect: staleRevisionEffect,
    } as never, '0.2')).toThrow(/new Node revision/i);
  });

  it('canonicalizes only bounded inert I-JSON without invoking hooks', () => {
    const inherited = Object.assign(Object.create({ inherited: true }), operation);
    expect(() => canonicalOperationDigest(inherited as never)).toThrow(/plain object/i);

    const toJSON = vi.fn(() => operation);
    expect(() => canonicalOperationDigest({ ...operation, payload: { toJSON } } as never))
      .toThrow(/plain JSON/i);
    expect(toJSON).not.toHaveBeenCalled();

    const getter = vi.fn(() => 'op-from-accessor');
    const accessor = { ...operation } as Record<string, unknown>;
    Object.defineProperty(accessor, 'opId', { enumerable: true, get: getter });
    expect(() => canonicalOperationDigest(accessor as never)).toThrow(/data properties/i);
    expect(getter).not.toHaveBeenCalled();

    expect(() => canonicalOperationDigest({
      ...operation,
      payload: { ...operation.payload, unsupported: undefined },
    } as never)).toThrow(/plain JSON/i);

    const payload: Record<string, unknown> = {};
    let nested = payload;
    for (let depth = 0; depth < 34; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    expect(() => canonicalOperationDigest({ ...operation, payload } as never)).toThrow(/depth/i);
  });

  it('accepts a cross-parent move when independent parents share a base revision token', () => {
    const sharedRevisionOperation = { ...operation, payload: { ...operation.payload,
      baseSourceParentRevision: 'shared-r1', baseTargetParentRevision: 'shared-r1' } };
    const draft = { ...effectInput, operationDigest: canonicalOperationDigest(sharedRevisionOperation),
      effectDigest: '' };
    const sharedRevisionEffect = { ...draft,
      effectDigest: canonicalAuthoritativeEffectDigest(draft as never) };
    expect(() => validateAuthoritativePullEvent({ cursor: 'receiver-cursor', kind: 'operation',
      operation: sharedRevisionOperation, effect: sharedRevisionEffect } as never, '0.2')).not.toThrow();
  });

  it.each([
    ['opId', { opId: 'wrong' }], ['replicaId', { replicaId: 'wrong' }], ['sequence', { sequence: 8 }],
    ['collectionId', { collectionId: 'wrong' }], ['operation type', { kind: 'node_created' }],
    ['operation digest', { operationDigest: 'sha-256=:bad=:' }], ['effect digest', { effectDigest: 'sha-256=:bad=:' }],
    ['digest case', { operationDigest: canonicalOperationDigest(operation).toUpperCase() }],
  ] as const)('rejects wrong %s binding', (_label, override) => {
    expect(() => validateAuthoritativePullEvent({ cursor: 'receiver-cursor', kind: 'operation', operation, effect: { ...effect, ...override } } as never, '0.2')).toThrow();
  });

  it('rejects wrong target parent revision after recomputing the valid effect digest', () => {
    const changed = { ...effect, parentRevisions: [{ parentId: 'wrong-parent', childrenRevision: 'cr-12' }] };
    changed.effectDigest = canonicalAuthoritativeEffectDigest(changed);
    expect(() => validateAuthoritativePullEvent({ cursor: 'receiver-cursor', kind: 'operation', operation,
      effect: changed } as never, '0.2')).toThrow('lacks authoritative source/target parent revisions');
  });

  it('rejects cycles and custom prototypes before digesting untrusted effects', () => {
    const cyclic = { cursor: 'receiver-cursor', kind: 'operation', operation, effect } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => validateAuthoritativePullEvent(cyclic as never, '0.2')).toThrow(/cycle/i);
    const inherited = Object.assign(Object.create({ secret: 'inherited' }), effect) as typeof effect;
    expect(() => validateAuthoritativePullEvent({ cursor: 'receiver-cursor', kind: 'operation', operation, effect: inherited } as never, '0.2')).toThrow(/plain/i);
  });

  it('preserves the 0.1 event shape and requires effect in 0.2', () => {
    expect(validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation', operation } as never, '0.1')).not.toHaveProperty('effect');
    expect(() => validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation', operation } as never, '0.2')).toThrow(/invalid|effect/i);
    expect(() => validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation', operation, effect } as never, '0.1')).toThrow(/0\.1|effect/i);
  });

  it('rejects subtree member count and page-chain inconsistencies', () => {
    const subtreeOperation = {
      ...operation,
      type: 'delete_subtree' as const,
      payload: { reason: 'removed' },
    };
    const rootTombstone = {
      resourceType: 'node' as const, targetId: 'node-1', collectionId: 'collection-1',
      scope: 'subtree' as const, deletedAt: '2026-07-27T00:00:00Z', deleteRevision: 'delete-r-1',
      operationId: 'op-1', affectedCount: 2, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'c',
    };
    const subtreeInput = {
      effectId: effect.effectId, status: effect.status, opId: effect.opId,
      replicaId: effect.replicaId, sequence: effect.sequence, collectionId: effect.collectionId,
      operationDigest: canonicalOperationDigest(subtreeOperation), effectDigest: digestB,
      kind: 'subtree_deleted' as const, memberCount: 2, memberDigest: digestA,
      members: ['only-one'], parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-13' },
      rootTombstone };
    const subtree = { ...subtreeInput, effectDigest: canonicalAuthoritativeEffectDigest(subtreeInput as never) };
    expect(() => validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation', operation: subtreeOperation, effect: subtree } as never, '0.2')).toThrow(/member/i);
    expect(() => validateAuthoritativePullEventPage({
      effectId: 'effect-1', pageNumber: 2, pageCount: 2, members: ['node-2'], memberCount: 1,
      pageDigest: digestB, previousPageDigest: null,
    }, { effectId: 'effect-1', expectedPageNumber: 2, pageCount: 2, previousPageDigest: digestA })).toThrow(/previous|chain/i);
    expect(() => validateAuthoritativePullEventPages([], {
      effectId: 'effect-1', rootId: 'node-1', pageCount: 1,
      memberCount: 1, memberDigest: digestA, firstPageDigest: digestB,
    })).toThrow(/incomplete/i);
  });

  it('binds paged effects to the exact trusted Manifest template', () => {
    const subtreeOperation = { ...operation, type: 'delete_subtree' as const, payload: { reason: 'removed' } };
    const members = ['node-1'];
    const memberDigest = canonicalAuthoritativeMemberDigest(members);
    const rootTombstone = {
      resourceType: 'node' as const, targetId: 'node-1', collectionId: 'collection-1',
      scope: 'subtree' as const, deletedAt: '2026-07-27T00:00:00Z', deleteRevision: 'delete-r-1',
      operationId: 'op-1', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'c',
    };
    const pageInput = { effectId: 'effect-pages', pageNumber: 1, pageCount: 1, members,
      memberCount: 1, pageDigest: digestA, previousPageDigest: null };
    const page = { ...pageInput, pageDigest: canonicalAuthoritativeEffectPageDigest(pageInput as never) };
    const input = {
      effectId: 'effect-pages', status: 'applied' as const, opId: 'op-1', replicaId: 'replica-source',
      sequence: 7, collectionId: 'collection-1', operationDigest: canonicalOperationDigest(subtreeOperation),
      effectDigest: digestB, kind: 'subtree_deleted' as const, rootTombstone, memberCount: 1,
      memberDigest, effectRef: {
        pageCount: 1, memberCount: 1, memberDigest, firstPageDigest: page.pageDigest },
      parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-13' },
    };
    const pagedEffect = { ...input, effectDigest: canonicalAuthoritativeEffectDigest(input as never) };
    const pagedEvent = { cursor: 'c', kind: 'operation', operation: subtreeOperation, effect: pagedEffect } as never;
    const trusted = { effectPageAuthority: 'https://sync.example',
      effectPageTemplate: 'https://sync.example/effects/{effectId}/pages/{pageNumber}' };
    expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2')).toThrow(/Manifest effect page template/i);
    expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2', {
      effectPageAuthority: trusted.effectPageAuthority,
    })).toThrow(/Manifest effect page template/i);
    expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2', trusted)).not.toThrow();
    expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2', {
      effectPageAuthority: 'https://other.example', effectPageTemplate: trusted.effectPageTemplate,
    })).toThrow(/crosses/i);
    for (const effectPageTemplate of [
      'https://other.example/effects/{effectId}/pages/{pageNumber}',
      'https://sync.example/effects/{effectId}/pages/1',
    ]) {
      expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2', {
        ...trusted, effectPageTemplate,
      })).toThrow();
    }
    expect(expandAuthoritativeEffectPageUrl(
      'https://sync.example/effects/{effectId}?page={pageNumber}', 'effect pages', 2,
    )).toBe('https://sync.example/effects/effect%20pages?page=2');
    for (const effectPageAuthority of ['not-an-origin', 'http://sync.example', 'https://sync.example/path']) {
      expect(() => validateAuthoritativePullEvent(pagedEvent, '0.2', {
        effectPageAuthority, effectPageTemplate: trusted.effectPageTemplate,
      })).toThrow(/HTTPS origin/i);
    }
  });

  it('rejects malformed effect-page expansion inputs before transport', () => {
    for (const [template, effectId, pageNumber] of [
      [123, 'effect-1', 1],
      ['https://sync.example/effects/{effectId}/pages/{pageNumber}', '', 1],
      ['https://sync.example/effects/{effectId}/pages/{pageNumber}', 'effect-1', 0],
      ['https://sync.example/effects/{effectId}/pages/{pageNumber}', 'effect-1', 1_025],
      ['https://sync.example/effects/{effectId}', 'effect-1', 1],
      ['https://sync.example/effects/{effectId}/{effectId}/{pageNumber}', 'effect-1', 1],
    ] as const) {
      expect(() => expandAuthoritativeEffectPageUrl(
        template as never, effectId, pageNumber,
      )).toThrow(/template|variables/i);
    }
    expect(() => assertAuthoritativeEffectPageUrlSafe('not-an-absolute-url')).toThrow();
  });

  it('rejects duplicate members across an otherwise valid complete page chain', () => {
    const firstInput = { effectId: 'effect-pages', pageNumber: 1, pageCount: 2, members: ['node-1'],
      memberCount: 1, pageDigest: digestA, previousPageDigest: null };
    const first = { ...firstInput, pageDigest: canonicalAuthoritativeEffectPageDigest(firstInput as never) };
    const secondInput = { effectId: 'effect-pages', pageNumber: 2, pageCount: 2, members: ['node-1'],
      memberCount: 1, pageDigest: digestA, previousPageDigest: first.pageDigest };
    const second = { ...secondInput, pageDigest: canonicalAuthoritativeEffectPageDigest(secondInput as never) };
    expect(() => validateAuthoritativePullEventPages([first, second] as never, {
      effectId: 'effect-pages', rootId: 'node-1', pageCount: 2,
      memberCount: 2, memberDigest: canonicalAuthoritativeMemberDigest(['node-1', 'node-1']),
      firstPageDigest: first.pageDigest,
    })).toThrow(/duplicate/i);
    const distinctSecondInput = { ...secondInput, members: ['node-2'] };
    const distinctSecond = { ...distinctSecondInput,
      pageDigest: canonicalAuthoritativeEffectPageDigest(distinctSecondInput as never) };
    const complete = validateAuthoritativePullEventPages([first, distinctSecond] as never, {
      effectId: 'effect-pages', rootId: 'node-1', pageCount: 2,
      memberCount: 2, memberDigest: canonicalAuthoritativeMemberDigest(['node-1', 'node-2']),
      firstPageDigest: first.pageDigest,
    });
    expect(complete).toHaveLength(2);
    expect(Object.isFrozen(complete)).toBe(true);
    const badPositionInput = { ...firstInput, pageNumber: 2, pageCount: 1,
      previousPageDigest: first.pageDigest };
    const badPosition = { ...badPositionInput,
      pageDigest: canonicalAuthoritativeEffectPageDigest(badPositionInput as never) };
    expect(() => validateAuthoritativePullEventPage(badPosition as never, {
      effectId: 'effect-pages', expectedPageNumber: 2, pageCount: 1,
      previousPageDigest: first.pageDigest,
    })).toThrow(/position/i);
    const badCountInput = { ...firstInput, memberCount: 2 };
    const badCount = { ...badCountInput,
      pageDigest: canonicalAuthoritativeEffectPageDigest(badCountInput as never) };
    expect(() => validateAuthoritativePullEventPage(badCount as never, {
      effectId: 'effect-pages', expectedPageNumber: 1, pageCount: 2, previousPageDigest: null,
    })).toThrow(/memberCount/i);
    expect(() => validateAuthoritativePullEventPage({ ...first, pageDigest: digestA } as never, {
      effectId: 'effect-pages', expectedPageNumber: 1, pageCount: 2, previousPageDigest: null,
    })).toThrow(/page digest/i);
    const singleInput = { ...firstInput, pageCount: 1 };
    const single = { ...singleInput,
      pageDigest: canonicalAuthoritativeEffectPageDigest(singleInput as never) };
    expect(() => validateAuthoritativePullEventPages([single] as never, {
      effectId: 'effect-pages', rootId: 'node-1', pageCount: 1,
      memberCount: 1, memberDigest: canonicalAuthoritativeMemberDigest(['node-1']),
      firstPageDigest: digestA,
    })).toThrow(/first page digest/i);
    expect(() => validateAuthoritativePullEventPages([single] as never, {
      effectId: 'effect-pages', rootId: 'node-1', pageCount: 1,
      memberCount: 1, memberDigest: digestA, firstPageDigest: single.pageDigest,
    })).toThrow(/series member digest/i);
  });

  it('validates create, update, delete, and inline subtree runtime authority', () => {
    const timestamp = '2026-07-27T00:00:00Z';
    const finalNode = {
      id: 'node-1', collectionId: 'collection-1', kind: 'folder' as const,
      parentId: 'folder-2', position: 'a', title: 'Final', createdAt: timestamp,
      updatedAt: timestamp, revision: 'r-9',
    };
    const common = { opId: 'op-1', replicaId: 'replica-source', sequence: 7,
      collectionId: 'collection-1', occurredAt: timestamp };
    const cases = [
      {
        operation: { ...common, type: 'create_node' as const, baseRevision: null,
          payload: { parentId: 'folder-2', afterId: null, beforeId: null,
            node: { kind: 'folder' as const, title: 'Final' } } },
        payload: { kind: 'node_created' as const, node: finalNode,
          placement: { parentId: 'folder-2', afterId: null, beforeId: null, position: 'a' },
          parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-9' },
          nodeChildrenRevision: 'cr-node-1' },
      },
      {
        operation: { ...common, type: 'update_node_content' as const, targetId: 'node-1',
          baseRevision: 'r-8', payload: { base: { title: 'Before' }, value: { title: 'Final' } } },
        payload: { kind: 'node_content_updated' as const, node: finalNode },
      },
      {
        operation: { ...common, type: 'delete_node' as const, targetId: 'node-1',
          baseRevision: 'r-8', payload: { reason: 'removed' } },
        payload: (() => {
          const tombstone = { resourceType: 'node' as const, targetId: 'node-1',
            collectionId: 'collection-1', scope: 'single' as const, deletedAt: timestamp,
            deleteRevision: 'delete-r-1', operationId: 'op-1', affectedCount: 1,
            purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'c' };
          return { kind: 'node_deleted' as const, deletion: tombstone, tombstone,
            parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-10' } };
        })(),
      },
      {
        operation: { ...common, type: 'delete_subtree' as const, targetId: 'node-1',
          baseRevision: 'r-8', payload: { reason: 'removed' } },
        payload: { kind: 'subtree_deleted' as const,
          rootTombstone: { resourceType: 'node' as const, targetId: 'node-1',
            collectionId: 'collection-1', scope: 'subtree' as const, deletedAt: timestamp,
            deleteRevision: 'delete-r-2', operationId: 'op-1', affectedCount: 1,
            purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'c' },
          members: ['node-1'], memberCount: 1,
          memberDigest: canonicalAuthoritativeMemberDigest(['node-1']),
          parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-11' } },
      },
    ];
    for (const item of cases) {
      const input = { effectId: `effect-${item.operation.type}`, status: 'applied' as const,
        opId: 'op-1', replicaId: 'replica-source', sequence: 7, collectionId: 'collection-1',
        operationDigest: canonicalOperationDigest(item.operation as never), effectDigest: digestA,
        ...item.payload };
      const authority = { ...input, effectDigest: canonicalAuthoritativeEffectDigest(input as never) };
      expect(() => validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation',
        operation: item.operation, effect: authority } as never, '0.2')).not.toThrow();
      const invalidInput = item.operation.type === 'create_node'
        ? { ...authority, parentRevision: { parentId: 'wrong-parent', childrenRevision: 'cr-9' } }
        : item.operation.type === 'update_node_content'
          ? { ...authority, node: { ...finalNode, id: 'wrong-node' } }
          : item.operation.type === 'delete_node'
            ? { ...authority, deletion: { ...(authority as never as { deletion: object }).deletion, affectedCount: 2 } }
            : { ...authority, rootTombstone: {
              ...(authority as never as { rootTombstone: object }).rootTombstone, affectedCount: 2,
            } };
      const invalidAuthority = {
        ...invalidInput,
        effectDigest: canonicalAuthoritativeEffectDigest(invalidInput as never),
      };
      expect(() => validateAuthoritativePullEvent({ cursor: 'c', kind: 'operation',
        operation: item.operation, effect: invalidAuthority } as never, '0.2')).toThrow(/authoritative|authority|Tombstone|match/i);
    }
  });

  it.each(['delete_node', 'delete_subtree'] as const)(
    'reuses one immutable %s effect across receiver-bound Pull cursors',
    (type) => {
      const timestamp = '2026-07-27T00:00:00Z';
      const sourceOperation = { opId: `op-${type}`, replicaId: 'replica-source', sequence: 9,
        collectionId: 'collection-1', type, targetId: 'node-1', baseRevision: 'r-8',
        occurredAt: timestamp, payload: { reason: 'removed' } };
      const stableTombstone = { resourceType: 'node' as const, targetId: 'node-1',
        collectionId: 'collection-1', scope: type === 'delete_node' ? 'single' as const : 'subtree' as const,
        deletedAt: timestamp, deleteRevision: 'delete-r-9', operationId: sourceOperation.opId,
        affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z',
        deleteCursor: 'stable-server-mutation-cursor' };
      const payload = type === 'delete_node'
        ? { kind: 'node_deleted' as const, deletion: stableTombstone, tombstone: stableTombstone,
          parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-20' } }
        : { kind: 'subtree_deleted' as const, rootTombstone: stableTombstone, members: ['node-1'],
          memberCount: 1, memberDigest: canonicalAuthoritativeMemberDigest(['node-1']),
          parentRevision: { parentId: 'folder-2', childrenRevision: 'cr-20' } };
      const input = { effectId: `effect-${type}`, status: 'applied' as const,
        opId: sourceOperation.opId, replicaId: sourceOperation.replicaId,
        sequence: sourceOperation.sequence, collectionId: sourceOperation.collectionId,
        operationDigest: canonicalOperationDigest(sourceOperation as never), effectDigest: digestA,
        ...payload };
      const immutableEffect = Object.freeze({ ...input,
        effectDigest: canonicalAuthoritativeEffectDigest(input as never) });
      const first = validateAuthoritativePullEvent({ cursor: 'receiver-a-session-cursor',
        kind: 'operation', operation: sourceOperation, effect: immutableEffect } as never, '0.2');
      const second = validateAuthoritativePullEvent({ cursor: 'receiver-b-session-cursor',
        kind: 'operation', operation: sourceOperation, effect: immutableEffect } as never, '0.2');
      expect(first).toMatchObject({ effect: { effectDigest: immutableEffect.effectDigest } });
      expect(second).toMatchObject({ effect: { effectDigest: immutableEffect.effectDigest } });
      expect((first as never as { effect: { rootTombstone?: { deleteCursor: string };
        tombstone?: { deleteCursor: string } } }).effect.rootTombstone?.deleteCursor
        ?? (first as never as { effect: { tombstone: { deleteCursor: string } } }).effect.tombstone.deleteCursor)
        .toBe('stable-server-mutation-cursor');
    },
  );
});

it('validates nested N-1 Pull data instead of accepting opaque operation/conflict stubs', () => {
  expect(() => validateAuthoritativePullEvent({ cursor: 'cursor-1', kind: 'operation', operation: { opId: 'op' } } as never, '0.1')).toThrow(TypeError);
  expect(() => validateAuthoritativePullEvent({ cursor: 'cursor-1', kind: 'conflict', conflict: { id: 'conflict' } } as never, '0.1')).toThrow(TypeError);
  expect(validateAuthoritativePullEvent({ cursor: 'cursor-1', kind: 'operation', operation }, '0.1')).toMatchObject({ operation });
});
