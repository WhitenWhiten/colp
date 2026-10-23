import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { CHROME_BOOKMARK_NOT_FOUND, lookupBookmark, type BookmarkNode } from '../src/bookmark-api-error.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

export const scope: SyncScope = { environment: 'production', serverId: 'server-kns05', serverOrigin: 'https://known.example',
  accountId: 'account-kns05', browserProfileId: 'profile-kns05', collectionId: 'collection-kns05',
  replicaId: 'replica-receiver', generation: 1 };

export let indexedDB: IDBFactory;
export function installKns05IndexedDb() {
  beforeEach(() => { indexedDB = new IDBFactory(); });
}

export function mappingInput(nativeId: string, colpId: string): MappingInput {
  return { nativeId, colpId, rootNativeId: 'native-root', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: `sha256:${nativeId}` } };
}

export async function completeWithMappings(store: ReturnType<typeof createSyncStateStore>, pageId: string,
  prev: string, next: string, mappings: readonly MappingInput[]) {
  const eventId = `${pageId}-e1`;
  await store.stagePullPage(scope, {
    pageId, previousCursor: prev, nextCursor: next, collectionRevision: `rev-${pageId}`,
    pageDigest: `sha256:${pageId}`, events: [{
      eventId, cursor: next, operationId: `${pageId}-op`, effectId: `${pageId}-fx`,
      effectDigest: 'sha256:fx', operationDigest: 'sha256:op', kind: 'node_created', payload: {},
    }], effectPages: [],
  });
  await store.preparePullIntent(scope, eventId, {
    intentId: `intent:${eventId}`, correlationId: `corr:${pageId}`, operationId: `${pageId}-op`,
    eventId, effectId: `${pageId}-fx`, expected: { kind: 'create', nativeId: mappings[0]?.nativeId ?? 'native-x' },
    expiresAt: Date.now() + 60_000,
  });
  await store.commitPullEvent(scope, eventId, { mappings });
  await store.completePullPage(scope, pageId);
}

export async function mountBar(fixture: Awaited<ReturnType<typeof setup>>, input: {
  readonly nativeRootId: string; readonly remoteMountNodeId: string | null; readonly rootRole?: 'bookmarks-bar' }) {
  await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: input.nativeRootId,
    remoteMountNodeId: input.remoteMountNodeId, boundaryVersion: '1', materialized: false, status: 'active',
    ...(input.rootRole ? { rootRole: input.rootRole } : { rootRole: 'bookmarks-bar' }) });
}

/**
 * B3-1: product seams such as `RejoinChrome.getNative` model "missing" as `undefined`. Under the
 * honest double a bare `(await api.get(id))[0]` rejects instead, so adapters must classify exactly
 * like `src/pull-apply-runtime.ts` does: absence is normal, any other failure still throws.
 */
export async function nativeOrUndefined(api: PullBookmarkApi, id: string): Promise<BookmarkNode | undefined> {
  const looked = await lookupBookmark((nativeId) => api.get(nativeId), id);
  if (looked.class === 'present') return looked.nodes[0];
  if (looked.class === 'not_found') return undefined;
  throw new Error(looked.message);
}

export async function setup(crash?: string, omitNodeMappings = false,
  chrome: { readonly lenient?: boolean; readonly maxRecordBytes?: number } = {}) {
  const store = createSyncStateStore({ indexedDB, ...(chrome.maxRecordBytes ? { maxRecordBytes: chrome.maxRecordBytes } : {}) }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-kns05', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready' });
  const mapping = (nativeId: string, colpId: string, parentNativeId?: string) => ({ nativeId, colpId,
    rootNativeId: 'native-root', nodeKind: colpId === 'root-colp' ? 'folder' as const : 'bookmark' as const,
    ...(parentNativeId ? { parentNativeId } : {}), projection: { revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: colpId === 'root-colp' ? 'children-old' : null, digest: `sha256:${colpId}`,
      content: { title: colpId, url: 'https://example.test/' } } });
  await store.putMapping(scope, mapping('native-root', 'root-colp'));
  if (!omitNodeMappings) { await store.putMapping(scope, mapping('native-node', 'node-1', 'native-root'));
    await store.putMapping(scope, mapping('native-child', 'node-child', 'native-root')); }
  const api = chrome.lenient ? lenientChrome() : honestChrome();
  api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  // B3-1: `node-1`/`native-node` is declared a bookmark, so it must be a Chrome leaf. Seeding
  // `native-child` *under* it made the fixture unrepresentable in Chrome (a bookmark cannot have
  // children) and only survived because the lenient `remove` removed non-empty folders. Keeping
  // both nodes as siblings under `native-root` keeps every existing subject (subtree member sets
  // come from the event, not from the Chrome walk) while making the tree honest.
  if (!omitNodeMappings) { api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1',
    url: 'https://example.test/' }); api.seed({ id: 'native-child', parentId: 'native-root', index: 1,
    title: 'node-child', url: 'https://example.test/' }); }
  let crashBoundary = crash;
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-kns05',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', crash: (at: string) => {
      if (crashBoundary === at) { crashBoundary = undefined; throw new Error('worker_crash'); }
    } };
  const applier = createPullApplier(options);
  let ordinal = 0;
  const createEvent = (kind: 'Folder' | 'Bookmark' | 'Separator', sequence = ++ordinal) =>
    pullFixtures.createEvent({ kind, sequence, collectionId: scope.collectionId, parentId: 'root-colp' });
  const mutationEvent = (kind: 'update' | 'move' | 'delete') => pullFixtures.mutationEvent({ kind,
    sequence: ++ordinal, collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' });
  const page = (events: readonly unknown[], nextCursor = 'cursor-next') => pullFixtures.page({ events, nextCursor,
    collectionRevision: 'revision-next' });
  return { store, api, options, applier, createEvent, mutationEvent, page, corrupt: pullFixtures.corrupt,
    disableCrash: () => { crashBoundary = undefined; } };
}

export type Kns05Chrome = PullBookmarkApi & {
  readonly calls: Array<{ kind: string; nativeId?: string }>;
  /** Read log, kept apart from `calls` so "zero Chrome mutations" assertions stay exact. */
  readonly reads: Array<{ kind: 'get' | 'getChildren'; nativeId: string }>;
  seed(node: Record<string, unknown>): void;
  /** Honest reads for assertions that must not depend on `get` throwing. */
  getNode(id: string): Record<string, unknown> | undefined;
  all(): Array<Record<string, unknown>>;
  denyPermission(id: string): void;
  lastEvent?: { kind: 'create' | 'change' | 'move' | 'remove'; nativeId: string; details: any };
};

/**
 * A-02/A-11 (SR-02/SR-16): the default Chrome double is honest, matching
 * `srg-t03-delete-harness.honestChrome()` / `srg-t02-native-harness`. Real Chromium rejects
 * `get`/`update`/`move`/`remove` for unknown ids (it never returns `[]`), `removeTree` is
 * recursive, `getChildren` is index-ordered and `create` validates the parent. The previous
 * lenient double (`get` on a missing id -> `[]`, one-level `removeTree`, `update`/`remove` that
 * silently no-op) is what let SR-02 regress green; it now lives in `lenientChrome()` and must be
 * requested explicitly by a test whose subject really is lenient-device behaviour.
 */
export function honestChrome(): Kns05Chrome {
  const nodes = new Map<string, any>();
  const denied = new Set<string>();
  const calls: Array<{ kind: string; nativeId?: string }> = [];
  const requireNode = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error(CHROME_BOOKMARK_NOT_FOUND);
    if (denied.has(id)) throw new Error('User denied permission to modify bookmarks.');
    return node;
  };
  const childrenOf = (parentId: string) => [...nodes.values()].filter((node) => node.parentId === parentId)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const reindex = (parentId: string | undefined) => {
    if (!parentId) return;
    childrenOf(parentId).forEach((child, index) => { nodes.set(child.id, { ...child, index }); });
  };
  const deleteRecursive = (id: string): void => {
    for (const child of childrenOf(id)) deleteRecursive(child.id);
    nodes.delete(id);
  };
  const reads: Array<{ kind: 'get' | 'getChildren'; nativeId: string }> = [];
  const api: Kns05Chrome = { calls, reads,
    seed(node: Record<string, unknown>) { nodes.set(String(node.id), { ...node }); reindex(node.parentId as string | undefined); },
    getNode(id: string) { return nodes.get(id); },
    all() { return [...nodes.values()]; },
    denyPermission(id: string) { denied.add(id); },
    async create(input: Record<string, unknown>) {
      const parentId = input.parentId as string | undefined;
      if (parentId) requireNode(parentId);
      const siblings = parentId ? childrenOf(parentId) : [];
      const index = typeof input.index === 'number' ? input.index : siblings.length;
      for (const sibling of siblings) {
        if ((sibling.index ?? 0) >= index) nodes.set(sibling.id, { ...sibling, index: (sibling.index ?? 0) + 1 });
      }
      const id = `created-${calls.length}`;
      const node = typeof input.url === 'string' ? { kind: 'bookmark', title: input.title, url: input.url }
        : { kind: 'folder', title: input.title };
      nodes.set(id, { id, parentId, index, title: input.title, url: input.url });
      api.calls.push({ kind: 'create', nativeId: id }); api.lastEvent = { kind: 'create', nativeId: id,
        details: { parentId: input.parentId, index, node } }; return { id };
    },
    async update(id: string, changes: Record<string, unknown>) { const current = requireNode(id);
      nodes.set(id, { ...current, ...changes });
      api.calls.push({ kind: 'update', nativeId: id });
      api.lastEvent = { kind: 'change', nativeId: id, details: changes }; },
    async move(id: string, destination: Record<string, unknown>) { const current = requireNode(id);
      const oldParent = current.parentId; nodes.delete(id); reindex(oldParent);
      const parentId = (destination.parentId ?? oldParent) as string | undefined;
      if (parentId) requireNode(parentId);
      const siblings = parentId ? childrenOf(parentId) : [];
      const requested = typeof destination.index === 'number' ? destination.index : siblings.length;
      const index = parentId === oldParent && typeof destination.index === 'number'
        && (current.index ?? 0) < requested ? requested - 1 : requested;
      for (const sibling of siblings) {
        if ((sibling.index ?? 0) >= index) nodes.set(sibling.id, { ...sibling, index: (sibling.index ?? 0) + 1 });
      }
      nodes.set(id, { ...current, ...destination, parentId, index });
      api.calls.push({ kind: 'move', nativeId: id });
      api.lastEvent = { kind: 'move', nativeId: id, details: { ...destination, parentId, index,
        oldParentId: oldParent ?? '', oldIndex: current.index ?? 0 } }; },
    async remove(id: string) { const before = requireNode(id);
      if (childrenOf(id).length) throw new Error("Can't remove non-empty folder (use removeTree).");
      nodes.delete(id); reindex(before.parentId); api.calls.push({ kind: 'delete', nativeId: id });
      api.lastEvent = { kind: 'remove', nativeId: id,
        details: { parentId: before.parentId ?? '', index: before.index ?? 0 } }; },
    async removeTree(id: string) { const before = requireNode(id);
      deleteRecursive(id); reindex(before.parentId); api.calls.push({ kind: 'delete', nativeId: id });
      api.lastEvent = { kind: 'remove', nativeId: id,
        details: { parentId: before.parentId ?? '', index: before.index ?? 0 } }; },
    // Reads are logged before validation so a rejected read still counts (A-02 asserts a frozen
    // scope never repeats the same `get`).
    async get(id: string) { reads.push({ kind: 'get', nativeId: id }); return [requireNode(id)]; },
    async getChildren(id: string) { reads.push({ kind: 'getChildren', nativeId: id });
      requireNode(id); return childrenOf(id); } };
  return api;
}

/**
 * The pre-B3-1 lenient double, kept verbatim for the few tests whose subject *is* lenient
 * device behaviour (see the `lenientChrome` call sites and their comments). Never make this the
 * default again: `get` -> `[]` masks SR-02 exactly.
 */
export function lenientChrome(): Kns05Chrome {
  const nodes = new Map<string, any>();
  const reads: Array<{ kind: 'get' | 'getChildren'; nativeId: string }> = [];
  const api: Kns05Chrome = { calls: [] as Array<{ kind: string; nativeId?: string }>, reads,
    seed(node: Record<string, unknown>) { nodes.set(String(node.id), node); },
    getNode(id: string) { return nodes.get(id); },
    all() { return [...nodes.values()]; },
    denyPermission() { throw new Error('denyPermission() needs honestChrome(); the lenient double has no denial model.'); },
    async create(input: Record<string, unknown>) { const id = `created-${api.calls.length}`;
      const node = typeof input.url === 'string' ? { kind: 'bookmark', title: input.title, url: input.url }
        : { kind: 'folder', title: input.title };
      nodes.set(id, { id, parentId: input.parentId, index: input.index, title: input.title, url: input.url });
      api.calls.push({ kind: 'create', nativeId: id }); api.lastEvent = { kind: 'create', nativeId: id,
        details: { parentId: input.parentId, index: input.index, node } }; return { id }; },
    async update(id: string, changes: Record<string, unknown>) { nodes.set(id, { ...nodes.get(id), ...changes });
      api.calls.push({ kind: 'update', nativeId: id });
      api.lastEvent = { kind: 'change', nativeId: id, details: changes }; },
    async move(id: string, destination: Record<string, unknown>) { const before = nodes.get(id);
      nodes.set(id, { ...before, ...destination });
      api.calls.push({ kind: 'move', nativeId: id });
      api.lastEvent = { kind: 'move', nativeId: id, details: { ...destination,
        oldParentId: before?.parentId ?? '', oldIndex: before?.index ?? 0 } }; },
    async remove(id: string) { const before = nodes.get(id); nodes.delete(id); api.calls.push({ kind: 'delete', nativeId: id });
      api.lastEvent = { kind: 'remove', nativeId: id,
        details: { parentId: before?.parentId ?? '', index: before?.index ?? 0 } }; },
    async removeTree(id: string) { for (const node of [...nodes.values()]) if (node.parentId === id) nodes.delete(node.id);
      return api.remove(id); },
    async get(id: string) { reads.push({ kind: 'get', nativeId: id });
      const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id: string) { reads.push({ kind: 'getChildren', nativeId: id });
      return [...nodes.values()].filter((node) => node.parentId === id); } };
  return api;
}

/** Honest by default (A-11). `fakeApi({ lenient: true })` is the explicit opt-in. */
export function fakeApi(options: { readonly lenient?: boolean } = {}): Kns05Chrome {
  return options.lenient ? lenientChrome() : honestChrome();
}
