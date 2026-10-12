import type { MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { ProjectionNode } from '../src/bookmark-subscriptions/contracts.js';
import { canonical, digest, nodeRef } from '../src/bookmark-subscriptions/projection.js';
import { row, scope } from './bookmark-subscriptions-fixture.js';

export function projectionContext(mapping: ReturnType<typeof row>, nodes: ProjectionNode[]): MaintenanceContext {
  const editions = [...new Set(nodes.flatMap(n => n.editionId ? [n.editionId] : []))];
  const readable = new Set(nodes.flatMap(n => { const ref = nodeRef(n, mapping.source); return ref ? [canonical(ref)] : []; }));
  const descriptor = { snapshotId: 'review-snapshot', source: mapping.source, mappingId: mapping.id, generation: 'g1',
    digestMode: mapping.mapping.digestMode, editionLimit: mapping.mapping.editionLimit, projectionVersion: '1', projectionRevision: 'p2', projectionEtag: '"p2"',
    policyRevision: 'policy', contentDigest: digest(nodes), rootKey: nodes[0]!.key,
    counts: { nodes: nodes.length, bookmarks: nodes.filter(n => n.kind === 'bookmark' && n.role === 'content').length, editions: editions.length, skipped: 0 },
    skippedByReason: [], editions: editions.map(editionId => ({ editionId, title: 'Edition', publishedAt: '2026-09-24T00:00:00Z' })), expiresAt: new Date(Date.now() + 900000).toISOString(), maxPageSize: 200 };
  const request = async (path: string, options: { ifNoneMatch?: string; body?: { nodes: unknown[] } } = {}) => {
    if (path.endsWith('/projection')) return options.ifNoneMatch === '"p2"' ? { status: 304, etag: '"p2"' }
      : { status: 200, etag: '"p2"', data: { state: 'available', mappingId: mapping.id, generation: 'g1' } };
    if (path.endsWith('snapshots')) return { status: 201, data: descriptor };
    if (path.endsWith('/nodes')) return { status: 200, data: { snapshotId: descriptor.snapshotId, projectionRevision: 'p2', items: nodes, nextCursor: null, complete: true } };
    const fence = { mappingId: mapping.id, generation: 'g1', mappingRevision: 'r1', authorityRevision: 'a1', contentEnabled: true, state: 'available' };
    if (path.endsWith('node-access-checks')) return { status: 200, data: { ...fence, requestDigest: digest(options.body!.nodes), removeNodes: options.body!.nodes.filter(ref => !readable.has(canonical(ref))) } };
    if (path.includes('/access')) return { status: 200, data: { ...fence, removeEditionIds: [] } };
    if (path.endsWith('/' + mapping.id)) return { status: 200, data: mapping.mapping };
    throw new Error('Unexpected review fixture route: ' + path);
  };
  return { scope, assertCurrent: async () => {}, client: { request } } as MaintenanceContext;
}
