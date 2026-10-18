import { canonicalAuthoritativeEffectDigest, canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { AuthoritativePullEffect, Operation, SyncPullEventV02 } from '@know-n/colp/types';

export const pullFixtures = Object.freeze({
  createEvent(input: { kind: 'Folder' | 'Bookmark' | 'Separator'; sequence: number; collectionId: string;
    parentId: string; replicaId?: string; afterId?: string; beforeId?: string; folderRole?: string;
    extensions?: Record<string, unknown>; opId?: string; title?: string }) {
    const kind = input.kind.toLowerCase(); const operation: any = baseOperation('create_node', input);
    if (input.opId) operation.opId = input.opId;
    const folderTitle = input.title ?? (input.folderRole === 'recovered' ? 'Recovered' : 'Remote');
    operation.payload = { parentId: input.parentId, node: kind === 'bookmark'
      ? { kind, title: input.title ?? 'Remote', url: 'https://example.test/' }
      : kind === 'folder' ? { kind, title: folderTitle } : { kind } };
    const node = { ...fullNode(kind, `node-created-${input.sequence}`, input.collectionId, input.parentId, folderTitle),
      position: `p${input.sequence}`, ...(input.folderRole ? { folderRole: input.folderRole } : {}),
      ...(input.extensions ? { extensions: input.extensions } : {}) };
    if (input.extensions) operation.payload.node.extensions = input.extensions;
    if (input.folderRole) operation.payload.node.folderRole = input.folderRole;
    return boundEvent(operation, { kind: 'node_created', node, placement: { parentId: input.parentId,
      afterId: input.afterId ?? null, beforeId: input.beforeId ?? null, position: `p${input.sequence}` },
      parentRevision: { parentId: input.parentId,
      childrenRevision: `children-${input.sequence}` }, nodeChildrenRevision: kind === 'folder' ? `children-node-${input.sequence}` : null });
  },
  restoreEvent(input: { sequence: number; collectionId: string; targetId: string; parentId: string;
    replicaId?: string; title?: string; afterId?: string; beforeId?: string; targetKind?: 'bookmark' | 'folder' }) {
    const operation: any = baseOperation('restore_node', input); operation.targetId = input.targetId;
    operation.baseRevision = `delete-${input.sequence}`;
    operation.payload = { reason: 'restore' };
    const kind = input.targetKind ?? 'bookmark';
    const node = { ...fullNode(kind, input.targetId, input.collectionId, input.parentId, input.title ?? 'Remote'),
      position: `p${input.sequence}`, revision: `revision-restored-${input.sequence}` };
    const consumedTombstone = tombstoneFor({ ...operation, targetId: input.targetId }, 'single', 1);
    return boundEvent(operation, { kind: 'node_restored', node, placement: { parentId: input.parentId,
      afterId: input.afterId ?? null, beforeId: input.beforeId ?? null, position: `p${input.sequence}` },
      parentRevision: { parentId: input.parentId, childrenRevision: `children-${input.sequence}` },
      consumedTombstone });
  },
  mutationEvent(input: { kind: 'update' | 'move' | 'delete'; sequence: number; collectionId: string;
    targetId: string; parentId: string; replicaId?: string; targetKind?: 'bookmark' | 'folder' }) {
    const type = input.kind === 'update' ? 'update_node_content' : input.kind === 'move' ? 'move_node' : 'delete_node';
    const operation: any = baseOperation(type, input); operation.targetId = input.targetId; operation.baseRevision = 'revision-old';
    operation.payload = input.kind === 'update' ? { base: { title: 'node-1', url: 'https://example.test/' },
      value: { title: 'Remote update' } } : input.kind === 'move' ? { newParentId: input.parentId,
      baseSourceParentRevision: 'children-old', baseTargetParentRevision: 'children-old' } : { reason: 'remote' };
    if (input.kind === 'update') return boundEvent(operation, { kind: 'node_content_updated',
      node: fullNode(input.targetKind ?? 'bookmark', input.targetId, input.collectionId, input.parentId, 'Remote update') });
    if (input.kind === 'move') return boundEvent(operation, { kind: 'node_moved',
      node: { ...fullNode(input.targetKind ?? 'bookmark', input.targetId, input.collectionId, input.parentId),
        position: `p${input.sequence}` },
      placement: { parentId: input.parentId,
        afterId: null, beforeId: null, position: `p${input.sequence}` }, parentRevisions: [{ parentId: input.parentId,
        childrenRevision: `children-${input.sequence}` }] });
    const tombstone = tombstoneFor(operation, 'single', 1); return boundEvent(operation, { kind: 'node_deleted',
      deletion: tombstone, tombstone, parentRevision: { parentId: input.parentId, childrenRevision: `children-${input.sequence}` } });
  },
  subtreeEvent(input: { sequence: number; collectionId: string; targetId: string; members: string[]; paged: boolean }) {
    const operation: any = baseOperation('delete_subtree', input); operation.targetId = input.targetId;
    operation.baseRevision = 'revision-old'; operation.payload = { reason: 'remote' };
    const memberDigest = canonicalAuthoritativeMemberDigest(input.members); const base: any = { kind: 'subtree_deleted',
      rootTombstone: tombstoneFor(operation, 'subtree', input.members.length), memberCount: input.members.length,
      memberDigest, parentRevision: { parentId: 'root-colp', childrenRevision: `children-${input.sequence}` } };
    if (input.paged) { const raw: any = { effectId: operation.opId, pageNumber: 1, pageCount: 1, members: input.members,
      memberCount: input.members.length, pageDigest: '', previousPageDigest: null };
      raw.pageDigest = canonicalAuthoritativeEffectPageDigest(raw); base.effectRef = { pageCount: 1,
        memberCount: input.members.length, memberDigest, firstPageDigest: raw.pageDigest }; const event: any = boundEvent(operation, base);
      event.__effectPages = [raw]; return event; }
    base.members = input.members; return boundEvent(operation, base);
  },
  page(input: { events: readonly any[]; nextCursor: string; collectionRevision: string }) {
    const effectPages = input.events.flatMap((event) => event.__effectPages ?? []);
    const events = input.events.map(({ __effectPages: _ignored, ...event }, index) => index === input.events.length - 1
      ? { ...event, cursor: input.nextCursor } : event);
    return { events, nextCursor: input.nextCursor, hasMore: false, collectionRevision: input.collectionRevision,
      recommendedPullAfterSeconds: 0, ...(effectPages.length ? { effectPages } : {}) };
  },
  corrupt(page: any, fault: string) { const value = structuredClone(page);
    if (fault === 'invalid_effect') value.events[0].effect.kind = 'node_moved';
    if (fault === 'tampered_digest') value.events[0].effect.effectDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    if (fault === 'wrong_source') value.events[0].effect.collectionId = 'other-collection';
    if (fault === 'missing_effect_page') { const subtree = pullFixtures.subtreeEvent({ sequence: 99,
      collectionId: value.events[0].operation.collectionId, targetId: 'node-1', members: ['node-1'], paged: true });
      const missing = pullFixtures.page({ events: [subtree], nextCursor: value.nextCursor,
        collectionRevision: value.collectionRevision }) as any; delete missing.effectPages; return missing; }
    return value; },
});

function baseOperation(type: string, input: { sequence: number; collectionId: string; replicaId?: string }) { return { opId: `op-${input.sequence}`,
  replicaId: input.replicaId ?? 'replica-source', sequence: input.sequence, collectionId: input.collectionId, type, baseRevision: null,
  occurredAt: '2026-07-28T00:00:00.000Z', dependencies: [], payload: {} }; }
function fullNode(kind: string, id: string, collectionId: string, parentId: string, title = 'Remote'): any {
  const common = { id, collectionId, kind, parentId, position: 'p1', visibility: 'private', revision: `revision-${id}`,
    createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z' };
  return kind === 'bookmark' ? { ...common, title, url: 'https://example.test/' }
    : kind === 'folder' ? { ...common, title } : common; }
function boundEvent(operation: Operation, rawEffect: Record<string, unknown>): SyncPullEventV02 {
  const input: any = { effectId: operation.opId, status: 'applied', opId: operation.opId, replicaId: operation.replicaId,
    sequence: operation.sequence, collectionId: operation.collectionId, operationDigest: canonicalOperationDigest(operation),
    effectDigest: '', ...rawEffect }; input.effectDigest = canonicalAuthoritativeEffectDigest(input as AuthoritativePullEffect);
  return { cursor: `cursor-${operation.sequence}`, kind: 'operation', operation, effect: input } as SyncPullEventV02;
}
function tombstoneFor(operation: any, scope: 'single' | 'subtree', affectedCount: number) { return { resourceType: 'node',
  targetId: operation.targetId, collectionId: operation.collectionId, scope, deletedAt: '2026-07-28T00:00:00.000Z',
  deleteRevision: `delete-${operation.sequence}`, operationId: operation.opId, deleteCursor: `cursor-${operation.sequence}`,
  affectedCount, purgeAfter: '2026-08-28T00:00:00.000Z' }; }
