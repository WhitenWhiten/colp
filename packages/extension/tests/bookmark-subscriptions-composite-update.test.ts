import { afterEach, expect, test, vi } from 'vitest';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { nodeRef } from '../src/bookmark-subscriptions/projection.js';
import type { ProjectionNode } from '../src/bookmark-subscriptions/contracts.js';
import { database, row, root, leaf, owned } from './bookmark-subscriptions-fixture.js';
import { positionedNativeFixture } from './bookmark-subscriptions-position-fixture.js';
import { projectionContext } from './bookmark-subscriptions-composite-fixture.js';
const databases: ReturnType<typeof database>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(databases.splice(0).map(db => db.close())); });

async function scenario() {
  const db = database(); databases.push(db);
  const fixture = positionedNativeFixture(), base = row();
  const mapping = { ...base, source: { sourceType: 'digest_series' as const, sourceId: 'series' },
    mapping: { ...base.mapping, digestMode: 'latest' as const, editionLimit: 1 }, rootNativeId: 'native-root', state: 'current' as const };
  const digestRoot = { ...root, key: JSON.stringify(['synthetic', 'root', 'digest_series', 'series']) };
  const sourceLink: ProjectionNode = { ...leaf('source'), key: JSON.stringify(['synthetic', 'source_link', 'digest_series', 'series']), parentKey: digestRoot.key, role: 'source_link' };
  const folder: ProjectionNode = { key: JSON.stringify(['synthetic', 'edition_folder', 'series', 'edition']), parentKey: digestRoot.key, kind: 'folder', role: 'edition_folder', editionId: 'edition', title: 'Edition', index: 1 };
  const editionLink: ProjectionNode = { ...leaf('read'), key: JSON.stringify(['synthetic', 'edition_link', 'series', 'edition']), parentKey: folder.key, role: 'edition_link', editionId: 'edition', index: 0 };
  const child: ProjectionNode = { ...leaf('child'), key: JSON.stringify(['digest', 'series', 'edition', 'collection', 'child']), parentKey: folder.key, editionId: 'edition', index: 1 };
  await db.put('mappings', mapping);
  for (const [node, id, parent] of [[digestRoot, 'native-root', 'bar'], [sourceLink, 'native-source-link', 'native-root'], [folder, 'native-edition', 'native-root'], [editionLink, 'native-edition-link', 'native-edition'], [child, 'native-child', 'native-edition']] as const) {
    fixture.nodes.set(id, { id, parentId: parent, title: node.title, index: node.index, ...(node.url ? { url: node.url } : {}) });
    await db.put('nodes', { ...owned(mapping, node, id, parent), ref: nodeRef(node, mapping.source) });
  }
  const desired = [digestRoot, sourceLink, { ...editionLink, parentKey: digestRoot.key, index: 1 }, { ...child, parentKey: digestRoot.key, title: 'Renamed remotely', index: 2 }];
  const ctx = projectionContext(mapping, desired);
  const run = async () => {
    const native = createNativeExecutor(db, fixture.api);
    const maintenance = createMaintenance(db, native);
    await native.recover((await db.get('mappings', mapping.id))!);
    await maintenance.content(ctx, (await db.get('mappings', mapping.id))!);
    const applied = await db.nodesForMapping(mapping.id);
    expect(applied.map(n => n.key).sort()).toEqual(desired.map(n => n.key).sort());
    expect(fixture.nodes.has('native-edition')).toBe(false);
    expect(fixture.nodes.get('native-child')).toMatchObject({ id: 'native-child', parentId: 'native-root', title: 'Renamed remotely', index: 2 });
    expect(await fixture.api.getChildren('native-root')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-source-link', index: 0 }), expect.objectContaining({ id: 'native-edition-link', index: 1 })]));
    expect(await db.pendingOperations()).toHaveLength(0);
    expect(await db.get('mappings', mapping.id)).toMatchObject({ state: 'current', lastAppliedRevision: 'p2' });
    const calls = fixture.calls.length;
    await maintenance.content(ctx, (await db.get('mappings', mapping.id))!);
    expect(fixture.calls).toHaveLength(calls);
  };
  return { db, fixture, mapping, folder, child, desired, ctx, run };
}

test.each(['received', 'settled'] as const)('Digest mode change resumes after the content update is %s before moving', async phase => {
  const s = await scenario(), change = s.db.changeOperation.bind(s.db);
  let stopped = false;
  const injection = vi.spyOn(s.db, 'changeOperation').mockImplementation(async (id, patch) => {
    const result = await change(id, patch);
    const boundary = phase === 'received' ? patch.phase === 'received' : patch.settled;
    if (!stopped && result.kind === 'update' && result.nativeId === 'native-child' && boundary) { stopped = true; throw new Error('worker_stopped'); }
    return result;
  });
  await expect(createMaintenance(s.db, createNativeExecutor(s.db, s.fixture.api)).content(s.ctx, s.mapping)).rejects.toThrow('worker_stopped');
  const prior = await s.db.nodeForNative('native-child');
  expect(prior?.node.parentKey).toBe(s.folder.key);
  expect(prior?.parentNativeId).toBe('native-edition');
  injection.mockRestore();
  await s.db.close();
  await s.run();
  expect(s.fixture.calls.filter(call => call === 'update:native-child')).toHaveLength(1);
});

test('legacy settled intent with a premature logical parent is reconciled using its native parent', async () => {
  const s = await scenario();
  const desired = s.desired.at(-1)!;
  s.fixture.nodes.get('native-child')!.title = desired.title;
  await createNativeExecutor(s.db, s.fixture.api).own(s.mapping, { ...desired, index: s.child.index }, 'native-child', 'native-edition');
  await s.db.close();
  await s.run();
  expect(s.fixture.calls).not.toContain('update:native-child');
});

test('an incomplete obsolete-node cleanup cannot commit the projection as current', async () => {
  const s = await scenario(), native = createNativeExecutor(s.db, s.fixture.api);
  const remove = native.removeOwned.bind(native);
  vi.spyOn(native, 'removeOwned').mockImplementation(async (mapping, selected, ...rest) => {
    if (selected.has(s.folder.key)) return;
    return remove(mapping, selected, ...rest);
  });
  await expect(createMaintenance(s.db, native).content(s.ctx, s.mapping)).rejects.toThrow('projection_incomplete');
  expect((await s.db.get('mappings', s.mapping.id))?.lastAppliedRevision).toBeUndefined();
  expect(fixtureCount(s)).toBe(5);
});

function fixtureCount(s: Awaited<ReturnType<typeof scenario>>) { return [...s.fixture.nodes.values()].filter(n => n.id !== '0' && n.id !== 'bar').length; }
