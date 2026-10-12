import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalOperationDigest, canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { reopenT03, setupT03, seedMappedNode, t03Scope } from './srg-t03-delete-harness.js';

for (const queued of [false, true]) for (const crash of [false, true]) {
  test(`DS-07 preserves local title and records remote URL (queued=${queued}, crash=${crash})`, async () => {
    let f = await setupT03(crash ? 'after_browser_call' : undefined);
    await seedMappedNode(f, { nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'bookmark', title: 'Local title', url: 'https://example.test/' });
    const queue = createBookmarkEventQueue({ store: f.store, scope: t03Scope, autoFlush: false,
      api: { get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
        getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })) } });
    await queue.changed('native-node', { title: 'Local title' });
    if (queued) await queue.flush();
    const original = f.mutationEvent('update');
    if (original.kind !== 'operation' || original.effect.kind !== 'node_content_updated') throw new Error('fixture');
    const operation = { ...original.operation, payload: { base: { title: 'node-1', url: 'https://example.test/' },
      value: { title: 'Remote update', url: 'https://example.test/updated' } } };
    const effect = { ...original.effect, node: { ...original.effect.node, url: 'https://example.test/updated' },
      operationDigest: canonicalOperationDigest(operation) };
    effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
    const event = { ...original, operation, effect };
    await f.applier.stage(f.page([event]));
    if (crash) { await assert.rejects(f.applier.resume(), /worker_crash/); f = await reopenT03(f); }
    await f.applier.resume();
    assert.equal(f.api.getNode('native-node')?.title, 'Local title');
    // An uncaptured edit creates a durable barrier: keep the complete native
    // snapshot and retain the remote content as an observation for reconciliation.
    assert.equal(f.api.getNode('native-node')?.url, queued ? 'https://example.test/updated' : 'https://example.test/');
    const observation = await f.store.getRemoteObservation(t03Scope, 'node-1');
    assert.equal(observation?.payload.title, 'Remote update');
    assert.equal(observation?.payload.url, 'https://example.test/updated');
    const inbox = await f.store.listBookmarkEvents(t03Scope);
    assert.equal(inbox[0]?.status, queued ? 'processed' : 'pending');
  });
}
