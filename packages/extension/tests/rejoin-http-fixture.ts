import { vi } from 'vitest';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { credentialAuthorityDigest } from '../src/session-client.js';
import type { SyncScope } from '../src/sync-state-store.js';
import type { StoredSession } from '../src/types.js';
import { manifest } from './auth-shell-fixture.js';

export const REJOIN_TOKEN = 'rejoin-test-access-token';
export async function rejoinSession(scope: SyncScope): Promise<StoredSession> {
  return { sessionId: 'rejoin-session', credentialAuthorityDigest: await credentialAuthorityDigest(REJOIN_TOKEN),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cloud-cursor', serverRevision: 'cloud-revision' },
    replicaLease: { leaseId: 'rejoin-lease', generation: String(scope.generation), state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    conversionPolicy: { separator: 'preserve_remote' } };
}

/** HTTP is the sole snapshot seam: manifest discovery, credential binding,
 * page validation and complete-tree consumption all run the shipped code. */
export function installRejoinHttp(scope: () => SyncScope, facts: () => readonly RemoteNodeFact[]) {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = scope(), url = new URL(String(input));
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.href === `${target.serverOrigin}/manifest.json`) return json(manifest(target.serverOrigin));
    if (url.origin !== target.serverOrigin || url.pathname !== '/v1/snapshot') throw new Error(`Unexpected HTTP: ${url.pathname}`);
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${REJOIN_TOKEN}`
      || url.searchParams.get('sessionId') !== 'rejoin-session'
      || new Headers(init?.headers).get('Known-Sync-Session') !== 'rejoin-session') throw new Error('snapshot_auth_missing');
    const pages = snapshotPages(target, facts());
    const index = url.searchParams.has('pageCursor') ? Number(url.searchParams.get('pageCursor')) : 0;
    if (!Number.isInteger(index) || !pages[index]) throw new Error('unexpected_snapshot_cursor');
    return json(pages[index]);
  });
  return requests;
}

function snapshotPages(scope: SyncScope, facts: readonly RemoteNodeFact[]) {
  const rootId = facts.find(row => row.folderRole === 'root' && row.parentId === null)?.nodeId ?? 'library-root';
  const all = facts.some(row => row.nodeId === rootId) ? [...facts] : [
    { nodeId: rootId, parentId: null, kind: 'folder' as const, folderRole: 'root', title: 'Library',
      revision: 'library-revision', childrenRevision: 'library-children' }, ...facts,
  ];
  const time = '2026-10-20T00:00:00Z';
  const nodes = all.map((row, index) => ({ id: row.nodeId, collectionId: scope.collectionId,
    kind: row.nodeId === rootId ? 'root' : row.kind, parentId: row.nodeId === rootId ? null : row.parentId ?? rootId,
    position: row.nodeId === rootId ? null : row.position ?? String(index).padStart(6, '0'),
    title: row.title, revision: row.revision, ...(row.url ? { url: row.url } : {}),
    ...(row.folderRole ? { folderRole: row.folderRole } : {}),
    ...(row.kind === 'bookmark' ? { tags: row.tags ?? [] } : {}),
    ...(row.kind === 'folder' && row.nodeId !== rootId && typeof row.description === 'string' ? { description: row.description } : {}),
    createdAt: time, updatedAt: time, extensions: row.extensions ?? {} }));
  const base = { protocolVersion: '0.2', snapshotId: 'rejoin-snapshot', mode: 'sync', complete: true,
    collection: { schemaVersion: '0.1', id: scope.collectionId, kind: 'bookmarks', title: 'Library', rootNodeId: rootId,
      visibility: 'private', createdAt: time, updatedAt: time, revision: 'cloud-revision', extensions: {} },
    annotations: [], attachments: [], relations: [], tombstones: [], revision: 'cloud-revision',
    syncCursor: 'cloud-cursor', generatedAt: time, warnings: [] };
  const pages = [];
  for (let offset = 0; offset < nodes.length; offset += 2) {
    const pageNodes = nodes.slice(offset, offset + 2), hasMore = offset + 2 < nodes.length;
    pages.push({ ...base, nodes: pageNodes,
      parentRevisions: pageNodes.filter(row => row.kind === 'root' || row.kind === 'folder').map(row => ({
        parentId: row.id, childrenRevision: all.find(fact => fact.nodeId === row.id)?.childrenRevision ?? `children-${row.id}`,
      })), page: { nextCursor: hasMore ? String(pages.length + 1) : null, hasMore, sequence: pages.length + 1 } });
  }
  return pages;
}
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
