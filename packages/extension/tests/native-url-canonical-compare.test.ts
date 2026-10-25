import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { sameNativeContentValue } from '../src/native-event-correlation.js';
import { unqueuedNativeContentFields } from '../src/pull-native-content-barrier.js';
import { protectedRejoinDeletions } from '../src/scope-rejoin-placement.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/**
 * B-11: the server keeps a URL exactly as it was sent, Chrome serialises it its own way ("https://a.test" becomes
 * "https://a.test/"). A Pull applied the server's spelling to Chrome and later read Chrome's spelling as a local edit:
 * a remote delete was "retained", a remote title edit was not applied and a local update was staged instead.
 */
installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof setup>>;

const RAW = 'https://example.test';
const CHROME = 'https://example.test/';

/** node-1 as a Pull of a server-spelled URL leaves it: the mapping keeps the server's spelling, Chrome holds its own. */
async function withServerSpelling(fixture: Fixture) {
  const { scopeKey: _scopeKey, ...mapping } = (await fixture.store.getMappingByColpId(scope, 'node-1'))! as
    Awaited<ReturnType<Fixture['store']['getMappingByColpId']>> & { scopeKey?: string };
  await fixture.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection,
    content: { title: 'node-1', url: RAW } } });
  fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1', url: CHROME });
}

describe('comparing a stored address with Chrome\'s', () => {
  test('one address in two spellings is the same bookmark; a title and a different address are not', () => {
    assert.equal(sameNativeContentValue('url', CHROME, RAW), true);
    assert.equal(sameNativeContentValue('url', 'https://EXAMPLE.test:443/a/../b', 'https://example.test/b'), true);
    assert.equal(sameNativeContentValue('url', 'https://example.test/a', 'https://example.test/b'), false);
    assert.equal(sameNativeContentValue('url', 'https://example.test/?q=1', 'https://example.test/'), false);
    assert.equal(sameNativeContentValue('title', 'A', 'a'), false);
    assert.equal(sameNativeContentValue('title', 'https://example.test/', 'https://example.test'), false, 'only addresses are normalised');
    assert.equal(sameNativeContentValue('url', 'javascript:void(0)', 'javascript:void(0)'), true);
    assert.equal(sameNativeContentValue('url', undefined, RAW), false);
  });

  test('the barrier sees no local edit in Chrome\'s own spelling, and still sees a real one', () => {
    const known = { title: 'node-1', url: RAW };
    assert.deepEqual(unqueuedNativeContentFields({ title: 'node-1', url: CHROME }, known, {}), {});
    assert.deepEqual(unqueuedNativeContentFields({ title: 'node-1', url: CHROME }, known, { title: 'node-1', url: RAW }), {});
    assert.deepEqual(unqueuedNativeContentFields({ title: 'node-1', url: 'https://other.test/' }, known, {}),
      { url: 'https://other.test/' });
    assert.deepEqual(unqueuedNativeContentFields({ title: 'Mine', url: CHROME }, known, {}), { title: 'Mine' });
  });
});

describe('a Pull onto a bookmark whose address Chrome spells differently', () => {
  test('a remote title edit is applied, and nothing else is written or staged', async () => {
    const fixture = await setup();
    try {
      await withServerSpelling(fixture);
      const update = pullFixtures.mutationEvent({ kind: 'update', sequence: 91, collectionId: scope.collectionId,
        targetId: 'node-1', parentId: 'root-colp', url: RAW });
      await fixture.applier.stage(fixture.page([update], 'cursor-1'));
      await fixture.applier.resume();
      assert.equal(fixture.api.getNode('native-node')?.title, 'Remote update', 'the remote edit reached Chrome');
      assert.equal(fixture.api.getNode('native-node')?.url, CHROME);
      assert.deepEqual(await fixture.store.listBookmarkEventsByStatus(scope, 'pending'), [],
        'Chrome\'s own spelling was not staged as a local edit');
      assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('a remote delete removes the bookmark instead of retaining it', async () => {
    const fixture = await setup();
    try {
      await withServerSpelling(fixture);
      const removal = pullFixtures.mutationEvent({ kind: 'delete', sequence: 92, collectionId: scope.collectionId,
        targetId: 'node-1', parentId: 'root-colp' });
      await fixture.applier.stage(fixture.page([removal], 'cursor-1'));
      await fixture.applier.resume();
      assert.equal(fixture.api.getNode('native-node'), undefined, 'the bookmark is gone, not "retained"');
    } finally { fixture.store.close(); }
  });

  test('a real local edit of the address is still preserved and still protects the bookmark from a remote delete', async () => {
    const fixture = await setup();
    try {
      await withServerSpelling(fixture);
      fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1', url: 'https://mine.test/' });
      const removal = pullFixtures.mutationEvent({ kind: 'delete', sequence: 93, collectionId: scope.collectionId,
        targetId: 'node-1', parentId: 'root-colp' });
      await fixture.applier.stage(fixture.page([removal], 'cursor-1'));
      await fixture.applier.resume();
      assert.equal(fixture.api.getNode('native-node')?.url, 'https://mine.test/', 'the local edit survives the remote delete');
    } finally { fixture.store.close(); }
  });
});

describe('a scope rejoin', () => {
  const mapping = (url: string) => ({ nativeId: 'n1', colpId: 'c1', rootNativeId: 'root', nodeKind: 'bookmark' as const,
    projection: { revision: 'r', digest: 'd', content: { title: 'T', url } } });
  const protectedFor = async (nativeUrl: string, storedUrl: string) => protectedRejoinDeletions(
    { getNative: async () => ({ id: 'n1', title: 'T', url: nativeUrl }) } as never, [mapping(storedUrl)]);

  test('does not protect a bookmark only because Chrome spells its address differently', async () => {
    assert.equal((await protectedFor(CHROME, RAW)).size, 0);
  });

  test('still protects a bookmark whose address was really edited', async () => {
    assert.deepEqual([...await protectedFor('https://mine.test/', RAW)], ['n1']);
  });
});
