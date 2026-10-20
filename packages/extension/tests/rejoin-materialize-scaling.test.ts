import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { materializeUnmountedRejoinMembers } from '../src/scope-rejoin-materialize.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';

installKns05IndexedDb();

test.each(['deep', 'wide'] as const)('materializing 2501 %s remote folders visits each ancestry edge within a linear budget', async shape => {
  const f = await rejoinFixture();
  try {
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    const count = 2_501;
    let reads = 0;
    const mappings: MappingInput[] = Array.from({ length: count }, (_, index) => {
      const row: MappingInput = { colpId: `cloud-${index}`, nativeId: `unmounted:cloud-${index}`,
        parentColpId: shape === 'deep' && index ? `cloud-${index - 1}` : 'root-colp',
        rootNativeId: 'native-root', nodeKind: 'folder', projection: { revision: 'r1', digest: 'd1', content: { title: `${index}` } } };
      return new Proxy(row, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
    });
    // A temporarily unavailable native root isolates discovery cost while the production
    // materializer still validates every dependency and reports all work as unresolved.
    const result = await materializeUnmountedRejoinMembers({ ...f.native, store: f.store, scope, mount,
      getNative: async () => undefined }, mappings.reverse());
    expect(result).toEqual({ applied: 0, unknown: count });
    expect(reads).toBeLessThan(count * 80);
    expect(f.api.calls.filter(row => row.kind === 'create')).toHaveLength(0);
  } finally { f.store.close(); }
});
