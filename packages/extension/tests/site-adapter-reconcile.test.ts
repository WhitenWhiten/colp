import { expect, test } from 'vitest';
import { reconcileSnapshot } from '../src/site-adapters/reconcile-scan.js';
import { reconcileDifferences } from '../src/site-adapters/reconcile-diff.js';
import type { ReconcilePage } from '../src/site-adapters/reconcile-scan.js';
import type { ReconcileNode } from '../src/site-adapters/reconcile-model.js';
import type { Representation, SiteItem } from '../src/site-adapters/contracts.js';
const item: SiteItem = { id: 'post:one', identity: 'siteId', kind: 'post', title: 'One', url: 'https://posts.test/one' };
const page = (cursor: string | null = null, next: string | null = null): ReconcilePage => ({ request: { id: 'request', runId: 'run', deadlineAt: 100,
  context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', tabId: 1, routeEpoch: 0 },
  query: { kind: 'items', collectionId: 'saved', cursor } }, result: { status: 'ok', kind: 'items', collectionId: 'saved',
    page: { consistency: 'pointInTime', snapshotId: 'snapshot', coverage: 'complete', nextCursor: next, items: [{ item }] } } });
const node: ReconcileNode = { native: { kind: 'bookmark', nativeId: 'bookmark', bindingId: 'proof', dateAdded: 10, deviceId: 'device', proof: { kind: 'writeReceipt', id: 'write' } },
  title: 'One', url: item.url, parentId: 'folder', pinned: false, protected: false };
const rep: Representation = { connectionId: 'source', itemId: item.id, sourceCollectionId: 'saved', mountId: 'mount', purpose: 'sourceArchive', state: 'active',
  native: { ...node.native, kind: 'bookmark' }, manualRevision: 0, lastWritten: { title: item.title, url: item.url, parentId: 'folder' } };
test('only qualified contiguous closed snapshots prove absence; an empty best-effort response does not', () => {
  expect(reconcileSnapshot({}, 'saved', [page()]).absence).toBe('unverified');
  expect(reconcileSnapshot({ collectionSnapshot: 'pointInTime' }, 'saved', [page()]).absence).toBe('proven');
  expect(reconcileSnapshot({ collectionSnapshot: 'pointInTime' }, 'saved', [page(null, 'next')]).complete).toBe(false);
  expect(reconcileSnapshot({ collectionSnapshot: 'pointInTime' }, 'saved', [page('skipped')]).absence).toBe('unverified');
  const empty = page(); if (empty.result.status === 'ok') empty.result.page = { ...empty.result.page, items: [], consistency: 'bestEffort' };
  expect(reconcileSnapshot({ collectionSnapshot: 'pointInTime' }, 'saved', [empty]).absence).toBe('unverified');
});
test('snapshot changes, omissions and repeated items preserve positives without granting cleanup', () => {
  const first = page(null, 'next'), second = page('next');
  if (second.result.status === 'ok') second.result.page = { ...second.result.page, consistency: 'pointInTime', snapshotId: 'changed', omissions: [{ id: 'missing', reason: 'failed' }] };
  const result = reconcileSnapshot({ collectionSnapshot: 'pointInTime' }, 'saved', [first, second]);
  expect(result.items).toEqual([item]); expect(result.absence).toBe('unverified'); expect(result.complete).toBe(false);
});
const diff = (nodes: ReconcileNode[], representations: Representation[] = [rep], items: SiteItem[] = [item], proven = false) => reconcileDifferences({
  snapshot: { collectionId: 'saved', items, complete: true, absence: proven ? 'proven' : 'unverified', snapshotId: null, reason: null },
  representations, nodes, collectionParentId: 'folder', candidates: (i, n) => n.url === i.url });
test('pin and ordering do not change memberships or generate a title update', () => {
  expect(diff([{ ...node, pinned: true }])).toMatchObject([{ kind: 'present', choices: ['keep'] }]);
});
test('unseen items are pending verification while a proven removal can be archived', () => {
  expect(diff([node], [rep], [])).toMatchObject([{ kind: 'unverified', choices: ['keep'] }]);
  expect(diff([node], [rep], [], true)).toMatchObject([{ kind: 'sourceRemoved', choices: ['keep', 'archive'] }]);
  expect(diff([{ ...node, protected: true }], [rep], [], true)[0]!.choices).toEqual(['keep']);
});
test('user deletion stays explicit; matching personal nodes become candidates rather than a duplicate create', () => {
  expect(diff([], [{ ...rep, state: 'suppressed' }])).toMatchObject([{ kind: 'localDeleted', choices: ['keep', 'restore'] }]);
  expect(diff([node], [])).toMatchObject([{ kind: 'candidate', candidates: [node], choices: ['keep', 'adopt'] }]);
  expect(diff([{ ...node, url: 'https://else.test', protected: true }], [], [])).toMatchObject([{ kind: 'protected', choices: ['keep'] }]);
});
test('source title updates do not overwrite personal titles, and changed native identities are never rebound', () => {
  expect(diff([node], [rep], [{ ...item, title: 'Updated source' }])).toMatchObject([{ kind: 'title' }]);
  expect(diff([{ ...node, title: 'My title' }], [rep], [{ ...item, title: 'Updated source' }])).toMatchObject([{ kind: 'present', title: 'My title' }]);
  expect(diff([{ ...node, native: { ...node.native, dateAdded: 20 } }])[0]!.kind).toBe('localDeleted');
});
