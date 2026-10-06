import { describe, expect, it } from 'vitest';
import {
  canonicalOperationDigest, canonicalAuthoritativeEffectDigest, canonicalAuthoritativeMemberDigest,
  canonicalAuthoritativeEffectPageDigest, validateAuthoritativePullEvent, validateAuthoritativePullEventPages,
} from '../../src/sync/index.js';

const operation = { opId: 'op-1', replicaId: 'replica-1', sequence: 1, collectionId: 'collection-1',
  type: 'delete_subtree' as const, targetId: 'root-1', baseRevision: 'r1',
  occurredAt: '2026-09-25T00:00:00Z', payload: { reason: 'removed' } };

function inline(members: string[]) {
  const draft = { effectId: 'effect-1', status: 'applied' as const, opId: operation.opId,
    replicaId: operation.replicaId, sequence: operation.sequence, collectionId: operation.collectionId,
    operationDigest: canonicalOperationDigest(operation), effectDigest: '', kind: 'subtree_deleted' as const,
    memberCount: members.length, memberDigest: canonicalAuthoritativeMemberDigest(members), members,
    parentRevision: { parentId: 'parent-1', childrenRevision: 'cr2' },
    rootTombstone: { resourceType: 'node' as const, targetId: operation.targetId,
      collectionId: operation.collectionId, scope: 'subtree' as const,
      deletedAt: operation.occurredAt, deleteRevision: 'dr1', operationId: operation.opId,
      affectedCount: members.length, purgeAfter: '2026-10-25T00:00:00Z', deleteCursor: 'cursor-1' },
  };
  return { cursor: 'cursor-1', kind: 'operation' as const, operation,
    effect: { ...draft, effectDigest: canonicalAuthoritativeEffectDigest(draft) } };
}

function paged(members: string[]) {
  let previousPageDigest: string | null = null;
  const pages = members.map((member, index) => {
    const draft = { effectId: 'effect-1', pageNumber: index + 1, pageCount: members.length,
      members: [member], memberCount: 1, previousPageDigest, pageDigest: '' };
    const page = { ...draft, pageDigest: canonicalAuthoritativeEffectPageDigest(draft) };
    previousPageDigest = page.pageDigest;
    return page;
  });
  return { pages, reference: { effectId: 'effect-1', rootId: operation.targetId, pageCount: pages.length,
    memberCount: members.length, memberDigest: canonicalAuthoritativeMemberDigest(members),
    firstPageDigest: pages[0]!.pageDigest } };
}

describe('authoritative subtree root membership', () => {
  it('accepts a root included in exact inline authority', () => {
    expect(() => validateAuthoritativePullEvent(inline(['child-1', 'root-1']), '0.2')).not.toThrow();
  });

  it('rejects a missing inline root even after all digests are correctly recomputed', () => {
    expect(() => validateAuthoritativePullEvent(inline(['unrelated-1']), '0.2'))
      .toThrow('subtree_deleted exact members must include the deleted root.');
  });

  it('rejects an inline duplicate root with otherwise consistent digests and count', () => {
    expect(() => validateAuthoritativePullEvent(inline(['root-1', 'root-1']), '0.2'))
      .toThrow('Sync Pull Operation is invalid for COLP 0.2.');
  });

  it('accepts the root in a later page', () => {
    const { pages, reference } = paged(['child-1', 'root-1']);
    expect(validateAuthoritativePullEventPages(pages, reference)).toHaveLength(2);
  });

  it('rejects a missing paged root with a valid complete digest chain', () => {
    const { pages, reference } = paged(['unrelated-1', 'unrelated-2']);
    expect(() => validateAuthoritativePullEventPages(pages, reference))
      .toThrow('Authoritative Pull effect exact members must include the deleted root.');
  });

  it('rejects a duplicate root across pages', () => {
    const { pages, reference } = paged(['root-1', 'root-1']);
    expect(() => validateAuthoritativePullEventPages(pages, reference)).toThrow(/duplicate members/);
  });

  it('requires a caller to supply the validated effect root', () => {
    const { pages, reference } = paged(['root-1']);
    const { rootId: _rootId, ...unbound } = reference;
    expect(() => validateAuthoritativePullEventPages(pages, unbound as never)).toThrow(/deleted root/);
  });
});
