import { describe, expect, it } from 'vitest';
import { establishSyncRootMapping, type SyncRootMapping, type SyncRootMappingAdapter } from '../../src/sync/index.js';

function setup() {
  const roots: Array<{ browserRootId: string; serverRootId: string }> = [];
  const mappings = new Map<string, SyncRootMapping>();
  const adapter: SyncRootMappingAdapter = {
    loadRootMapping: async id => mappings.get(id),
    listBrowserRoots: async () => structuredClone(roots),
    readBrowserRoot: async id => roots.find(root => root.browserRootId === id),
    createBrowserRoot: async serverRootId => {
      const browserRootId = 'browser-' + (roots.length + 1);
      roots.push({ browserRootId, serverRootId });
      return browserRootId;
    },
    saveRootMapping: async mapping => { mappings.set(mapping.serverRootId, mapping); },
  };
  return { roots, mappings, adapter };
}

describe('concurrent root mapping [evidence:sync.root-mapping]', () => {
  it('coalesces concurrent first use of the same adapter and root', async () => {
    const { adapter, roots, mappings } = setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => establishSyncRootMapping('root', adapter)));
    expect(roots).toHaveLength(1);
    expect(results.every(result => result.browserRootId === results[0]!.browserRootId)).toBe(true);
    expect(mappings.get('root')).toEqual(results[0]);
  });

  it('does not combine different root identities', async () => {
    const { adapter, roots } = setup();
    const [a, b] = await Promise.all(['a', 'b'].map(id => establishSyncRootMapping(id, adapter)));
    expect(roots).toHaveLength(2);
    expect(a?.browserRootId).not.toBe(b?.browserRootId);
  });

  it('releases failed work and recovers a marked root after mapping save fails', async () => {
    const { adapter, roots } = setup();
    let fail = true;
    const original = adapter.saveRootMapping;
    const retryable = { ...adapter, saveRootMapping: async (mapping: SyncRootMapping) => {
      if (fail) throw new Error('save failed');
      await original(mapping);
    } };
    const failed = await Promise.allSettled([establishSyncRootMapping('root', retryable), establishSyncRootMapping('root', retryable)]);
    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    fail = false;
    expect((await establishSyncRootMapping('root', retryable)).browserRootId).toBe('browser-1');
    expect(roots).toHaveLength(1);
  });

  it('uses the host lock to serialize different adapter handles', async () => {
    const { adapter, roots } = setup();
    let tail: Promise<unknown> = Promise.resolve();
    const withRootMappingLock: NonNullable<SyncRootMappingAdapter['withRootMappingLock']> = async (_id, work) => {
      const next = tail.then(work);
      tail = next.catch(() => undefined);
      return next;
    };
    const [a, b] = await Promise.all([
      establishSyncRootMapping('root', { ...adapter, withRootMappingLock }),
      establishSyncRootMapping('root', { ...adapter, withRootMappingLock }),
    ]);
    expect(roots).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('rejects a lock that acknowledges without invoking its callback', async () => {
    const { adapter, roots } = setup();
    const broken = { ...adapter, withRootMappingLock: async () => undefined } as unknown as SyncRootMappingAdapter;
    await expect(establishSyncRootMapping('root', broken)).rejects.toThrow('completed callback result');
    expect(roots).toEqual([]);
  });
});
