import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

test('IA-10: the first engine metric after a worker restart preserves persisted counters', async () => {
  const saved: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(saved[key]) }),
    set: async (items: Record<string, unknown>) => { Object.assign(saved, structuredClone(items)); },
  } } });
  try {
    vi.resetModules();
    const first = await import('../src/kns-09-release.js');
    const persistence = await import('../src/kns-09-metrics.js');
    first.observeKns09EngineWake({ scope: {collectionId:'synthetic-collection', replicaId:'synthetic-replica'},
      frozenBefore:true, frozenAfter:false, pendingCount:0, backlogAgeMs:null });
    first.observeKns09EngineWake({ scope: {collectionId:'synthetic-collection', replicaId:'synthetic-replica'},
      frozenBefore:true, frozenAfter:false, pendingCount:0, backlogAgeMs:null });
    await persistence.persistKns09Metrics();
    assert.equal(first.snapshotKns09Metrics().counters[first.KNS09_METRICS.pullRecovery], 2);
    vi.resetModules();
    const second = await import('../src/kns-09-release.js');
    // runSyncEngine invokes this collector without first loading mutation switches.
    second.observeKns09EngineWake({ scope: {collectionId:'synthetic-collection', replicaId:'synthetic-replica'},
      frozenBefore:true, frozenAfter:false, pendingCount:0, backlogAgeMs:null });
    await (await import('../src/kns-09-metrics.js')).persistKns09Metrics();
    const snapshot = saved[persistence.KNS09_METRICS_STORAGE_KEY] as {counters:Record<string,number>};
    assert.equal(snapshot.counters[second.KNS09_METRICS.pullRecovery], 3);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});
