import type { BatchBookmarkApi, BatchChromeNode } from '../src/bookmark-batch-plan.js';
import { STORES } from '../src/sync-state/schema.js';
import type { SyncScope, createSyncStateStore } from '../src/sync-state-store.js';

export function defaultBatchTree(): BatchChromeNode {
  return {
    id: '0', title: '', children: [
      {
        id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', parentId: '0', index: 0, children: [
          { id: 'bm-1', title: 'One', url: 'https://a.test/one', parentId: 'bar', index: 0 },
          { id: 'bm-2', title: 'Two', url: 'https://b.test/two', parentId: 'bar', index: 1 },
          { id: 'folder-a', title: 'Folder A', parentId: 'bar', index: 2, children: [] },
        ],
      },
      {
        id: 'other', title: 'Other bookmarks', folderType: 'other', parentId: '0', index: 1, children: [
          { id: 'local-1', title: 'Local', url: 'https://local.test/', parentId: 'other', index: 0 },
        ],
      },
      {
        id: 'managed', title: 'Managed', unmodifiable: 'managed', folderType: 'managed', parentId: '0', index: 2,
        children: [],
      },
    ],
  };
}

export function createMemoryBookmarks(root: BatchChromeNode = defaultBatchTree()): BatchBookmarkApi & {
  readonly mutations: string[];
  node(id: string): BatchChromeNode | undefined;
} {
  let tree = structuredClone(root);
  let nextId = 0;
  const mutations: string[] = [];
  const byId = () => { const map = new Map<string, BatchChromeNode>(); index(tree, map); return map; };

  return {
    mutations,
    node: (id) => byId().get(id),
    async getTree() { return [tree]; },
    async get(id) {
      const node = byId().get(id);
      if (!node) throw new Error('not_found');
      return [node];
    },
    async move(id, destination) {
      mutations.push(`move:${id}`);
      const node = detach(id);
      const parent = byId().get(destination.parentId ?? node.parentId ?? '');
      if (!parent) throw new Error('target_missing');
      const children = [...(parent.children ?? [])];
      const index = destination.index ?? children.length;
      children.splice(index, 0, { ...node, parentId: parent.id, index });
      replace(parent.id, { ...parent, children: children.map((child, next) => ({ ...child, index: next })) });
      return byId().get(id)!;
    },
    async update(id, changes) {
      mutations.push(`update:${id}`);
      const node = byId().get(id);
      if (!node) throw new Error('missing');
      replace(id, { ...node, ...changes });
      return byId().get(id)!;
    },
    async create(input) {
      const parent = byId().get(input.parentId);
      if (!parent || parent.url) throw new Error('target_missing');
      const id = `restored-${++nextId}`; mutations.push(`create:${id}`);
      const children = [...parent.children ?? []];
      children.splice(input.index ?? children.length, 0, { id, ...input, ...(input.url === undefined ? { children: [] } : {}) });
      replace(parent.id, { ...parent, children: children.map((child, index) => ({ ...child, index })) });
      return byId().get(id)!;
    },
    async remove(id) { mutations.push(`remove:${id}`); detach(id); },
    async removeTree(id) { mutations.push(`removeTree:${id}`); detach(id); },
  };

  function index(node: BatchChromeNode, map: Map<string, BatchChromeNode>): void {
    map.set(node.id, node);
    for (const child of node.children ?? []) index(child, map);
  }

  function replace(id: string, next: BatchChromeNode): void {
    if (tree.id === id) { tree = next; return; }
    tree = rewrite(tree, id, next);
  }

  function detach(id: string): BatchChromeNode {
    const current = byId().get(id);
    if (!current) throw new Error('missing');
    const parent = current.parentId ? byId().get(current.parentId) : undefined;
    if (!parent) throw new Error('protected_root');
    replace(parent.id, {
      ...parent,
      children: (parent.children ?? []).filter((child) => child.id !== id)
        .map((child, index) => ({ ...child, index })),
    });
    return current;
  }
}

export async function parkRemoteDeleteNative(
  store: ReturnType<typeof createSyncStateStore>,
  scope: SyncScope,
  nativeId: string,
): Promise<void> {
  const exported = await store.exportScope(scope);
  const key = exported.scope?.scopeKey;
  if (!key) throw new Error('scope_missing');
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.remoteDeleteDecisions, 'readwrite');
    tx.objectStore(STORES.remoteDeleteDecisions).put({
      scopeKey: key, decisionId: `park-${nativeId}`, eventId: `ev-${nativeId}`, pageId: 'page-park',
      operationId: `op-${nativeId}`, effectId: `eff-${nativeId}`, effectDigest: 'sha256:park',
      targetId: 'node-park', deleteRevision: 'rev-park', generation: 1, nativeIds: [nativeId],
      nodeKind: 'bookmark', title: 'Parked', policy: 'confirm', action: 'pending', state: 'pending',
      casVersion: 1, updatedAt: 1,
    });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function rewrite(node: BatchChromeNode, id: string, next: BatchChromeNode): BatchChromeNode {
  if (node.id === id) return next;
  if (!node.children) return node;
  return { ...node, children: node.children.map((child) => rewrite(child, id, next)) };
}
