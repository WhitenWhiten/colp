import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readRebuildIdentityHints } from '../src/replica-rebuild-identity.js';
import { setup } from './replica-rebuild-harness.js';

async function rebuilt() {
  const f = await setup();
  for (const suffix of ['a', 'b']) await f.store.putMapping(f.scope, {
    nativeId: `native-${suffix}`, colpId: `node-${suffix}`, rootNativeId: 'local-kept', nodeKind: 'bookmark',
    parentNativeId: 'local-kept', parentColpId: 'root', projection: { revision: 'r1', digest: `sha256:${suffix}`,
      content: { title: 'Same title', url: 'https://example.test/repeated' } } });
  assert.equal((await f.rebuilder.handle(f.request)).ok, true);
  const scope = { ...f.scope, replicaId: (await f.credentials.loadBinding())!.replicaId };
  return { ...f, scope, oldScope: f.scope };
}

test('reset retains distinct proven identities across restart without copying queued operations', async () => {
  const f = await rebuilt();
  try {
    f.store.close();
    const hints = await readRebuildIdentityHints({ scope: f.scope, storage: f.journal, store: f.store });
    assert.deepEqual(hints, [{ nativeId: 'local-kept', colpId: 'root' },
      { nativeId: 'native-a', colpId: 'node-a' }, { nativeId: 'native-b', colpId: 'node-b' }]);
    assert.deepEqual(await f.store.listQueue(f.scope), []);
    assert.deepEqual(await f.store.listMappings(f.scope), [], 'identities must be checked against the fresh selected tree and Snapshot');
    const archive = await f.store.exportArchive(f.oldScope);
    assert.ok(Array.isArray(archive.queue)); assert.equal(archive.queue.length, 1);
  } finally { f.store.close(); }
});

test.each(['accountId', 'browserProfileId', 'collectionId', 'serverOrigin', 'serverId', 'environment'] as const)(
  'archive identity cannot cross %s', async field => {
    const f = await rebuilt();
    try {
      let reads = 0;
      const store = { exportArchive: async () => { reads++; throw new Error('must_not_read_another_owner'); } };
      const scope = { ...f.scope, [field]: field === 'serverOrigin' ? 'https://different.example' : 'different' };
      assert.deepEqual(await readRebuildIdentityHints({ scope, storage: f.journal, store }), []);
      assert.equal(reads, 0);
    } finally { f.store.close(); }
  });

test('a same-profile remount keeps identity evidence, while corrupt, provisional and conflicting records cannot claim natives', async () => {
  const f = await rebuilt();
  try {
    const archive = await f.store.exportArchive(f.oldScope);
    const store = { exportArchive: async () => ({ ...archive, mappings: [
      { nativeId: 'native-valid', colpId: 'node-valid', projection: { revision: 'r1' } },
      { nativeId: 'native-conflict', colpId: 'node-one', projection: { revision: 'r1' } },
      { nativeId: 'native-conflict', colpId: 'node-two', projection: { revision: 'r1' } },
      { nativeId: 'native-pending', colpId: 'pending-op', projection: { revision: 'r1' } },
      { nativeId: 'recovery:node-virtual', colpId: 'node-virtual', projection: { revision: 'r1' } },
      { nativeId: 'native-local', colpId: 'node-local', projection: { revision: 'local-root' } }, null,
    ] }) };
    assert.deepEqual(await readRebuildIdentityHints({ scope: { ...f.scope, replicaId: 'remounted', generation: 2 },
      storage: f.journal, store }), [{ nativeId: 'native-valid', colpId: 'node-valid' }]);
    assert.deepEqual(await readRebuildIdentityHints({ scope: f.scope, storage: f.journal,
      store: { exportArchive: async () => ({ ...archive, reason: 'logout_cleanup' }) } }), []);
  } finally { f.store.close(); }
});
