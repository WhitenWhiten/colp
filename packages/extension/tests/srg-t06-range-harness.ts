import { IDBFactory } from 'fake-indexeddb';
import { createPullApplier } from '../src/pull-applier.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { honestChrome, type HonestChrome } from './srg-t03-delete-harness.js';

export const t06Scope: SyncScope = {
  environment: 'production', serverId: 'server-t06', serverOrigin: 'https://known.example',
  accountId: 'account-t06', browserProfileId: 'profile-t06', collectionId: 'collection-t06',
  replicaId: 'replica-t06', generation: 1,
};

export type T06Fixture = Awaited<ReturnType<typeof setupT06>>;

export function folderMapping(nativeId: string, colpId: string, input: {
  readonly parentNativeId?: string; readonly parentColpId?: string; readonly rootNativeId?: string;
  readonly title?: string;
} = {}): MappingInput {
  const title = input.title ?? colpId;
  return {
    nativeId, colpId, rootNativeId: input.rootNativeId ?? 'native-root', nodeKind: 'folder',
    ...(input.parentNativeId ? { parentNativeId: input.parentNativeId } : {}),
    ...(input.parentColpId ? { parentColpId: input.parentColpId } : {}),
    projection: {
      revision: `revision-${colpId}`, resourceRevision: `revision-${colpId}`, childrenRevision: `children-${colpId}`,
      digest: `sha256:${colpId}`, content: { title },
    },
  };
}

export function bookmarkMapping(nativeId: string, colpId: string, input: {
  readonly parentNativeId: string; readonly parentColpId: string; readonly rootNativeId?: string;
  readonly title?: string; readonly url?: string;
}): MappingInput {
  const title = input.title ?? colpId;
  const url = input.url ?? 'https://example.test/leaf';
  return {
    nativeId, colpId, rootNativeId: input.rootNativeId ?? 'native-root', nodeKind: 'bookmark',
    parentNativeId: input.parentNativeId, parentColpId: input.parentColpId,
    projection: {
      revision: `revision-${colpId}`, resourceRevision: `revision-${colpId}`, childrenRevision: null,
      digest: `sha256:${colpId}`, content: { title, url },
    },
  };
}

export async function setupT06(input: {
  readonly crash?: string; readonly sourceStatus?: 'active' | 'detached'; readonly destStatus?: 'active' | 'detached' | 'pending';
} = {}) {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...t06Scope, lifecycle: 'active',
    lease: { leaseId: 'lease-t06', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
    selectedRoots: ['root-colp', 'other-colp'], rootStatus: 'ready', firstRun: 'completed',
  });
  const api = honestChrome();
  api.seed({ id: 'native-root', index: 0, title: 'Bar' });
  api.seed({ id: 'native-other', index: 0, title: 'Other' });
  api.seed({ id: 'native-folder', parentId: 'native-root', index: 0, title: 'Moved folder' });
  api.seed({ id: 'native-mid', parentId: 'native-folder', index: 0, title: 'Mid folder' });
  api.seed({
    id: 'native-leaf', parentId: 'native-mid', index: 0, title: 'Leaf', url: 'https://example.test/leaf',
  });
  await store.putMapping(t06Scope, folderMapping('native-root', 'root-colp', { title: 'Bar' }));
  await store.putMapping(t06Scope, folderMapping('native-other', 'other-colp', {
    rootNativeId: 'native-other', title: 'Other',
  }));
  await store.putMapping(t06Scope, folderMapping('native-folder', 'node-folder', {
    parentNativeId: 'native-root', parentColpId: 'root-colp', title: 'Moved folder',
  }));
  await store.putMapping(t06Scope, folderMapping('native-mid', 'node-mid', {
    parentNativeId: 'native-folder', parentColpId: 'node-folder', title: 'Mid folder',
  }));
  await store.putMapping(t06Scope, bookmarkMapping('native-leaf', 'node-leaf', {
    parentNativeId: 'native-mid', parentColpId: 'node-mid', title: 'Leaf',
  }));
  await store.putMountBinding(t06Scope, {
    mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: true, status: input.sourceStatus ?? 'detached', rootRole: 'bookmarks-bar',
    ...(input.sourceStatus === 'detached' || input.sourceStatus === undefined ? {
      pauseBaseline: {
        generation: 1, boundaryVersion: '1', lastAppliedCursor: 'cursor-old', completeness: 'complete' as const,
      },
    } : {}),
  });
  await store.putMountBinding(t06Scope, {
    mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: true, status: input.destStatus ?? 'active', rootRole: 'other-bookmarks',
    ...(input.destStatus === 'detached' ? {
      pauseBaseline: {
        generation: 1, boundaryVersion: '1', lastAppliedCursor: 'cursor-old', completeness: 'complete' as const,
      },
    } : {}),
  });
  let crashHits = 0;
  let crashAt: string | undefined = input.crash;
  let crashIndex = 0;
  const options = {
    scope: t06Scope, store, api,
    session: {
      acceptedProtocolVersion: '0.2' as const, sessionId: 'session-t06',
      collectionId: t06Scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const },
    },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example',
    crash: (at: string) => {
      if (crashAt !== at) return;
      if (crashHits !== crashIndex) { crashHits += 1; return; }
      crashAt = undefined;
      throw new Error('worker_crash');
    },
  };
  const applier = createPullApplier(options);
  let ordinal = 80;
  return {
    indexedDB, store, api, options, applier,
    moveFolderEvent: (parentId = 'other-colp') => pullFixtures.mutationEvent({
      kind: 'move', sequence: ++ordinal, collectionId: t06Scope.collectionId,
      targetId: 'node-folder', parentId, targetKind: 'folder',
    }),
    updateBarEvent: () => pullFixtures.mutationEvent({
      kind: 'update', sequence: ++ordinal, collectionId: t06Scope.collectionId,
      targetId: 'node-folder', parentId: 'root-colp', targetKind: 'folder',
    }),
    page: (events: readonly unknown[], nextCursor = 'cursor-next') =>
      pullFixtures.page({ events, nextCursor, collectionRevision: 'revision-next' }),
    disableCrash: () => { crashAt = undefined; },
    setCrash: (at: string, index = 0) => { crashAt = at; crashIndex = index; crashHits = 0; },
  };
}

export async function reopenT06(fixture: T06Fixture) {
  fixture.store.close();
  const store = createSyncStateStore({ indexedDB: fixture.indexedDB });
  const options = { ...fixture.options, store, crash: fixture.options.crash };
  return { ...fixture, store, options, applier: createPullApplier(options) };
}

export function destTree(api: HonestChrome, destRoot = 'native-other') {
  const folder = api.all().find((node) => node.parentId === destRoot && node.id.startsWith('created-'))
    ?? api.all().find((node) => node.parentId === destRoot && node.id === 'dest-empty');
  const mid = folder ? api.all().find((node) => node.parentId === folder.id && node.title === 'Mid folder') : undefined;
  const leaf = mid ? api.all().find((node) => node.parentId === mid.id && node.title === 'Leaf') : undefined;
  return { folder, mid, leaf };
}

export function sourceCopies(api: HonestChrome) {
  return {
    folder: api.getNode('native-folder'),
    mid: api.getNode('native-mid'),
    leaf: api.getNode('native-leaf'),
  };
}
