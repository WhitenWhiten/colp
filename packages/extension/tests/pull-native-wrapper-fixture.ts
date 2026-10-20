import { vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { createPullApplier } from '../src/pull-applier.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { snapshotNativeFixture } from './snapshot-native-authority-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { rejoinSession } from './rejoin-http-fixture.js';

/** Actual credential/session fence, policy, IDB, applier and mutation adapter.
 * Only the external Chrome port and subscription read timing are controlled. */
export async function pullNativeWrapperFixture() {
  const f = await snapshotNativeFixture(), native = honestChrome();
  for (const node of f.chrome.nodes.values()) native.seed(node);
  vi.stubGlobal('chrome', { bookmarks: native });
  await f.store.putMapping(f.scope, { ...f.privateRoot, nativeId: '4', colpId: 'destination',
    projection: { revision: 'destination-r1', digest: 'destination', childrenRevision: 'destination-c1',
      content: { title: 'Parent' } } });
  async function applier() {
    const effects = await f.effects(createChromePullBookmarkApi()), session = await rejoinSession(f.scope);
    await effects.assertCurrent();
    return createPullApplier({ store: f.store, scope: f.scope, api: effects.api, assertCurrent: effects.assertCurrent,
      session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId, collectionId: f.scope.collectionId,
        conversionPolicy: { separator: 'preserve_remote' } },
      effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
      effectPageAuthority: f.scope.serverOrigin });
  }
  async function stage(kind: 'update' | 'move' | 'delete') {
    let event = pullFixtures.mutationEvent({ kind, sequence: 1, collectionId: f.scope.collectionId,
      targetId: 'target', parentId: kind === 'move' ? 'destination' : 'root' });
    if (event.kind !== 'operation') throw new Error('fixture_event');
    if (event.effect.kind === 'node_content_updated') {
      if (event.effect.node.kind !== 'bookmark' || event.effect.node.redacted
          || event.operation.type !== 'update_node_content') throw new Error('fixture_kind');
      const operation = { ...event.operation,
        payload: { base: { title: 'Target', url: 'https://target.test/' }, value: { title: 'Remote update' } } };
      const effect = { ...event.effect, node: { ...event.effect.node, url: 'https://target.test/' },
        operationDigest: canonicalOperationDigest(operation) };
      event = { ...event, operation, effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
    }
    const current = await applier();
    await current.stage(pullFixtures.page({ events: [event], nextCursor: 'next', collectionRevision: 'next-r1' }));
    return current;
  }
  return { ...f, get store() { return f.store; }, native, applier, stage };
}

export function duringNativeAdmission(change: () => Promise<unknown>) {
  const read = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let injected = false;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await read();
    if (!injected) { injected = true; await change(); }
    return rows;
  });
  return () => injected;
}
