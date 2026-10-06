import { describe, expect, it } from 'vitest';

import {
  establishSyncRootMapping,
  type SyncBrowserRoot,
  type SyncRootMapping,
  type SyncRootMappingAdapter,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.root-mapping]';

interface BrowserState {
  mappings: Map<string, SyncRootMapping>;
  roots: Map<string, SyncBrowserRoot>;
  nextId: number;
  saves: SyncRootMapping[];
  creates: string[];
}

function adapter(state: BrowserState): SyncRootMappingAdapter {
  return {
    loadRootMapping: async (serverRootId) => state.mappings.get(serverRootId),
    listBrowserRoots: async () => [...state.roots.values()],
    readBrowserRoot: async (browserRootId) => state.roots.get(browserRootId),
    createBrowserRoot: async (serverRootId) => {
      state.creates.push(serverRootId);
      const browserRootId = `browser-root-${state.nextId++}`;
      state.roots.set(browserRootId, { browserRootId, serverRootId, isRoot: true });
      return browserRootId;
    },
    saveRootMapping: async (mapping) => {
      state.saves.push(mapping);
      state.mappings.set(mapping.serverRootId, mapping);
    },
  };
}

function state(): BrowserState {
  return { mappings: new Map(), roots: new Map(), nextId: 41, saves: [], creates: [] };
}

describe(`SYNC-0022 Root Mapping creation and dynamic browser IDs ${evidence}`, () => {
  it(`creates a missing mapping using the browser-assigned ID and persists before returning ${evidence}`, async () => {
    const store = state();
    const result = await establishSyncRootMapping('sync-root-a', adapter(store));

    expect(result).toEqual({ serverRootId: 'sync-root-a', browserRootId: 'browser-root-41' });
    expect(store.creates).toEqual(['sync-root-a']);
    expect(store.saves).toEqual([result]);
    expect(store.mappings.get('sync-root-a')).toEqual(result);
  });

  it(`does not assume a fixed browser ID and reuses a valid persisted mapping ${evidence}`, async () => {
    const store = state();
    store.mappings.set('sync-root-a', { serverRootId: 'sync-root-a', browserRootId: 'profile-7-root-884' });
    store.roots.set('profile-7-root-884', {
      serverRootId: 'sync-root-a', browserRootId: 'profile-7-root-884', isRoot: true,
    });

    const result = await establishSyncRootMapping('sync-root-a', adapter(store));

    expect(result.browserRootId).toBe('profile-7-root-884');
    expect(store.creates).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it(`discovers a matching live root after a stale mapping and persists the discovered dynamic ID ${evidence}`, async () => {
    const store = state();
    store.mappings.set('sync-root-a', { serverRootId: 'sync-root-a', browserRootId: 'old-local-id' });
    store.roots.set('new-profile-root-9', {
      serverRootId: 'sync-root-a', browserRootId: 'new-profile-root-9', isRoot: true,
    });

    const result = await establishSyncRootMapping('sync-root-a', adapter(store));

    expect(result).toEqual({ serverRootId: 'sync-root-a', browserRootId: 'new-profile-root-9' });
    expect(store.creates).toHaveLength(0);
    expect(store.saves).toEqual([result]);
  });

  it(`rejects duplicate browser roots mapped to one Sync Root instead of selecting arbitrarily ${evidence}`, async () => {
    const store = state();
    store.roots.set('root-a', { serverRootId: 'sync-root-a', browserRootId: 'root-a', isRoot: true });
    store.roots.set('root-b', { serverRootId: 'sync-root-a', browserRootId: 'root-b', isRoot: true });

    await expect(establishSyncRootMapping('sync-root-a', adapter(store))).rejects.toThrow(
      'Multiple Browser Roots',
    );
    expect(store.creates).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it(`rejects persisted mappings whose server marker conflicts with the requested Sync Root ${evidence}`, async () => {
    const store = state();
    store.mappings.set('sync-root-a', { serverRootId: 'other-sync-root', browserRootId: 'browser-root-9' });

    await expect(establishSyncRootMapping('sync-root-a', adapter(store))).rejects.toThrow(
      'different Sync Root',
    );
  });

  it(`rejects a persisted browser node whose live marker belongs to another Sync Root ${evidence}`, async () => {
    const store = state();
    store.mappings.set('sync-root-a', { serverRootId: 'sync-root-a', browserRootId: 'browser-root-9' });
    store.roots.set('browser-root-9', {
      serverRootId: 'other-sync-root', browserRootId: 'browser-root-9', isRoot: true,
    });

    await expect(establishSyncRootMapping('sync-root-a', adapter(store))).rejects.toThrow(
      'conflicts with the browser root marker',
    );
    expect(store.creates).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it.each([undefined, null, ''])(`rejects an invalid Sync Root ID boundary (%j) ${evidence}`, async (value) => {
    const store = state();
    await expect(establishSyncRootMapping(value as string, adapter(store))).rejects.toThrow(
      'Server Root ID must be a non-empty identifier',
    );
    expect(store.creates).toHaveLength(0);
  });

  it(`rejects a browser that returns an empty assigned ID and does not persist it ${evidence}`, async () => {
    const store = state();
    const broken: SyncRootMappingAdapter = {
      ...adapter(store),
      createBrowserRoot: async () => '',
    };

    await expect(establishSyncRootMapping('sync-root-a', broken)).rejects.toThrow(
      'Browser Root ID must be a non-empty identifier',
    );
    expect(store.saves).toHaveLength(0);
  });

  it.each([undefined, null, ''])(`rejects malformed persisted browser IDs (%j) ${evidence}`, async (browserRootId) => {
    const store = state();
    store.mappings.set('sync-root-a', {
      serverRootId: 'sync-root-a', browserRootId: browserRootId as unknown as string,
    });

    await expect(establishSyncRootMapping('sync-root-a', adapter(store))).rejects.toThrow(
      'Browser Root ID must be a non-empty identifier',
    );
    expect(store.creates).toHaveLength(0);
  });
});
