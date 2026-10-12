import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { StoredSession } from '../src/types.js';
import { loadCompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { snapshot as snapshotFixture } from './durable-sync-engine-harness.js';
import type { SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://sync.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-engine',
  replicaId: 'replica-a', generation: 1,
});
const session = {
  sessionId: 'session-a', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
  acceptedProtocolVersion: '0.2' as const, snapshotRequired: false,
  collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
  replicaLease: { leaseId: 'lease-a', generation: '1', state: 'active' as const,
    expiresAt: '2099-01-01T00:00:00Z' },
  conversionPolicy: { separator: 'preserve_remote' as const },
} as StoredSession;

describe('advanced remote snapshot loader', () => {
  test('S-03 AUD-06 different per-page parentRevisions succeed; same parent conflict fails', async () => {
    const pages = validPages();
    let count = 0;
    const loaded = await loadCompleteRemoteSnapshot({
      endpoint: 'https://sync.example/v1/snapshot', origin: 'chrome-extension://extension',
      credential: { accessToken: 'access-token' }, session, scope,
      fetcher: async () => new Response(JSON.stringify(pages[count++]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    assert.equal(loaded.remoteFacts[0]?.childrenRevision, 'children-root');
    assert.equal(loaded.remoteFacts[1]?.childrenRevision, 'children-bar');
    const conflict = validPages();
    conflict[1]!.parentRevisions = [{ parentId: 'folder-bar', childrenRevision: 'other' }];
    let calls = 0;
    await assert.rejects(loadCompleteRemoteSnapshot({
      endpoint: 'https://sync.example/v1/snapshot', origin: 'chrome-extension://extension',
      credential: { accessToken: 'access-token' }, session, scope,
      fetcher: async () => new Response(JSON.stringify(conflict[calls++]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    }), /snapshot_parent_authority_invalid/);
  });

  test('assembles a complete paginated snapshot and preserves authority fields', async () => {
    const pages = validPages(); const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await loadCompleteRemoteSnapshot({ endpoint: 'https://sync.example/v1/snapshot',
      origin: 'chrome-extension://extension', credential: { accessToken: 'access-token' }, session, scope,
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(pages[requests.length - 1]), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      } });
    assert.equal(result.snapshotId, 'snapshot-engine');
    assert.equal(result.revision, 'revision-snapshot');
    assert.equal(result.syncCursor, 'bootstrap-cursor');
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.remoteFacts.map((row) => row.nodeId), ['root-server', 'folder-bar', 'bookmark-a']);
    assert.equal(result.remoteFacts[1]?.position, 'p1');
    assert.equal(result.remoteFacts[1]?.childrenRevision, 'children-bar');
    assert.equal(result.remoteFacts[2]?.position, 'p2');
    assert.equal(requests[0]?.init.headers && new Headers(requests[0]!.init.headers).get('Origin'),
      'chrome-extension://extension');
    assert.equal(new Headers(requests[0]!.init.headers).get('Authorization'), 'Bearer access-token');
    assert.equal(new Headers(requests[0]!.init.headers).get('Known-Sync-Session'), 'session-a');
    assert.equal(new URL(requests[1]!.url).searchParams.get('pageCursor'), 'page-2');
  });

  test.each([
    ['missing continuation cursor', (pages: any[]) => { pages[0]!.page = { nextCursor: null, hasMore: true, sequence: 1 }; }, 'snapshot_invalid'],
    ['wrong page sequence', (pages: any[]) => { pages[1]!.page.sequence = 3; }, 'snapshot_chain_invalid'],
    ['changed page identity', (pages: any[]) => { pages[1]!.snapshotId = 'snapshot-other'; }, 'snapshot_identity_conflict'],
    ['changed parent authority', (pages: any[]) => {
      pages[1]!.parentRevisions = [{ parentId: 'folder-bar', childrenRevision: 'children-changed' }];
    }, 'snapshot_parent_authority_invalid'],
    ['changed collection scope', (pages: any[]) => { pages[0]!.collection.id = 'collection-other'; }, 'snapshot_semantic_invalid'],
    ['missing root', (pages: any[]) => { pages[0]!.nodes = pages[0]!.nodes.slice(1); }, 'snapshot_graph_incomplete'],
    ['unreachable cycle', (pages: any[]) => {
      pages[0]!.nodes[1]!.parentId = 'bookmark-a';
    }, 'snapshot_graph_incomplete'],
  ] as const)('%s fails closed before returning facts', async (_name, mutate, code) => {
    const pages = validPages() as any[]; mutate(pages);
    let calls = 0;
    await assert.rejects(loadCompleteRemoteSnapshot({ endpoint: 'https://sync.example/v1/snapshot',
      origin: 'chrome-extension://extension', credential: { accessToken: 'access-token' }, session, scope,
      fetcher: async () => new Response(JSON.stringify(pages[calls++]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }) }), new RegExp(code));
  });

  test('rejects an abort caused by the request timeout without fetching a second page', async () => {
    let observedSignal: AbortSignal | undefined;
    await assert.rejects(loadCompleteRemoteSnapshot({ endpoint: 'https://sync.example/v1/snapshot',
      origin: 'chrome-extension://extension', credential: { accessToken: 'access-token' }, session, scope,
      requestTimeoutMilliseconds: 5,
      fetcher: async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw new DOMException('timed out', 'AbortError');
      } }), /snapshot_timeout/);
    assert.equal(observedSignal?.aborted, true);
  });
});

function validPages() {
  const base = snapshotFixture(1, false, null) as any;
  const root = base.nodes[0];
  const folder = { id: 'folder-bar', collectionId: scope.collectionId, kind: 'folder', parentId: root.id,
    position: 'p1', folderRole: 'bookmarks-bar', revision: 'revision-folder', title: 'Bar',
    createdAt: base.generatedAt, updatedAt: base.generatedAt, extensions: {} };
  const bookmark = { id: 'bookmark-a', collectionId: scope.collectionId, kind: 'bookmark', parentId: folder.id,
    position: 'p2', revision: 'revision-bookmark', title: 'A', url: 'https://example.test/a',
    createdAt: base.generatedAt, updatedAt: base.generatedAt, extensions: {} };
  const first = { ...base, nodes: [root, folder],
    parentRevisions: [{ parentId: root.id, childrenRevision: 'children-root' },
      { parentId: folder.id, childrenRevision: 'children-bar' }],
    page: { nextCursor: 'page-2', hasMore: true, sequence: 1 } };
  const second = { ...base, nodes: [bookmark], parentRevisions: [],
    page: { nextCursor: null, hasMore: false, sequence: 2 } };
  return [first, second];
}
