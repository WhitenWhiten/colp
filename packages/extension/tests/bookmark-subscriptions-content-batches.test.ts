import { afterEach, expect, test } from 'vitest';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { createMaintenance, type MaintenanceContext } from '../src/bookmark-subscriptions/maintenance.js';
import type { ProjectionNode } from '../src/bookmark-subscriptions/contracts.js';
import { digest } from '../src/bookmark-subscriptions/projection.js';
import { database, nativeFixture, row, root, leaf, owned, scope } from './bookmark-subscriptions-fixture.js';
const databases: ReturnType<typeof database>[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

async function scenario(kind: 'move' | 'parents' | 'remove', change: 'revision' | 'gate' | 'none') {
  const db = database(); databases.push(db);
  const fixture = nativeFixture();
  const mapping = { ...row(), rootNativeId: 'source-root', state: 'current' as const };
  await db.put('mappings', mapping);
  const folder = (id: string, index: number): ProjectionNode => ({ ...leaf(id), kind: 'folder', url: undefined, index });
  const a = folder('folder-a', 0), b = folder('folder-b', 1);
  const children = Array.from({ length: 260 }, (_, i) => ({ ...leaf('child-' + i, a.key), index: i }));
  for (const node of [root, a, b, ...children]) {
    const id = node === root ? 'source-root' : node.key;
    const parent = node.parentKey === root.key ? 'source-root' : node.parentKey ?? 'bar';
    fixture.nodes.set(id, { id, parentId: parent, title: node.title, index: node.index, ...(node.url ? { url: node.url } : {}) });
    await db.put('nodes', owned(mapping, node, id, parent));
  }
  const desired = [root, a, b];
  if (kind === 'move') desired.push(...children.map(n => ({ ...n, parentKey: b.key })));
  if (kind === 'parents') for (const [i, child] of children.entries()) {
    const parent = folder('new-folder-' + i, i + 2);
    desired.push(parent, { ...child, parentKey: parent.key, index: 0 });
  }
  let revision = 'r1', enabled = true, mutations = 0;
  const changed = () => {
    mutations++;
    if (change === 'revision') revision = 'r2';
    if (change === 'gate') enabled = false;
  };
  const api = { ...fixture.api,
    create: async (input: Parameters<typeof fixture.api.create>[0]) => { const result = await fixture.api.create(input); changed(); return result; },
    move: async (id: string, target: Parameters<typeof fixture.api.move>[1]) => { const result = await fixture.api.move(id, target); changed(); return result; },
    remove: async (id: string) => { await fixture.api.remove(id); changed(); },
  };
  const descriptor = { snapshotId: 'snapshot', source: mapping.source, mappingId: mapping.id, generation: 'g1',
    digestMode: null, editionLimit: null, projectionVersion: '1', projectionRevision: 'p1', projectionEtag: '"p1"',
    policyRevision: 'policy1', contentDigest: digest(desired), rootKey: root.key,
    counts: { nodes: desired.length, bookmarks: desired.filter(n => n.kind === 'bookmark').length, editions: 0, skipped: 0 },
    skippedByReason: [], editions: [], expiresAt: new Date(Date.now() + 900000).toISOString(), maxPageSize: 200 };
  const request = async (path: string, options: { ifNoneMatch?: string; body?: unknown } = {}) => {
    if (path.endsWith('/projection')) return options.ifNoneMatch ? { status: 304, etag: '"p1"' }
      : { status: 200, etag: '"p1"', data: { state: 'available', mappingId: mapping.id, generation: 'g1' } };
    if (path.endsWith('snapshots')) return { status: 201, data: descriptor };
    if (path.includes('/nodes')) {
      const start = Number(new URL(path, scope.serverOrigin).searchParams.get('cursor') ?? 0);
      const complete = start + 200 >= desired.length;
      return { status: 200, data: { snapshotId: 'snapshot', projectionRevision: 'p1',
        items: desired.slice(start, start + 200), nextCursor: complete ? null : String(start + 200), complete } };
    }
    const fence = { mappingId: mapping.id, generation: 'g1', mappingRevision: revision,
      authorityRevision: 'a1', contentEnabled: enabled, state: 'available' };
    return { status: 200, data: path.endsWith('node-access-checks')
      ? { ...fence, requestDigest: digest((options.body as { nodes: unknown }).nodes), removeNodes: [] }
      : { ...fence, removeEditionIds: [] } };
  };
  const ctx = { scope, assertCurrent: async () => {}, client: { request } } as MaintenanceContext;
  const maintenance = createMaintenance(db, createNativeExecutor(db, api));
  return { db, mapping, fixture, desired, mutations: () => mutations, run: () => maintenance.content(ctx, mapping) };
}

test.each(['revision', 'gate'] as const)('retained moves stop at the next batch after remote %s changes', async change => {
  const s = await scenario('move', change);
  await expect(s.run()).rejects.toThrow('configuration_changed');
  expect(s.mutations()).toBe(128);
  expect((await s.db.get('mappings', s.mapping.id))?.lastAppliedRevision).toBeUndefined();
});

test('required parent creation is fenced before a second batch or any retained move', async () => {
  const s = await scenario('parents', 'revision');
  await expect(s.run()).rejects.toThrow('configuration_changed');
  expect(s.fixture.calls.filter(c => c.startsWith('create:'))).toHaveLength(128);
  expect(s.fixture.calls.filter(c => c.startsWith('move:'))).toHaveLength(0);
});

test('obsolete deletion stops at the next batch when the content gate closes', async () => {
  const s = await scenario('remove', 'gate');
  await expect(s.run()).rejects.toThrow('configuration_changed');
  expect(s.fixture.calls.filter(c => c.startsWith('remove:'))).toHaveLength(128);
  expect(await s.db.nodesForMapping(s.mapping.id)).toHaveLength(135);
});

test('unchanged authority completes every move and commits the full projection', async () => {
  const s = await scenario('move', 'none');
  await s.run();
  // One move per retained child: staged by appending, they already sit in
  // snapshot order, so the final ordering pass has nothing left to move.
  expect(s.fixture.calls.filter(c => c.startsWith('move:'))).toHaveLength(260);
  const key = (id: string) => JSON.stringify(['collection', 'collection', id]);
  expect((await s.fixture.api.getChildren(key('folder-b'))).map(n => n.id)).toEqual(Array.from({ length: 260 }, (_, i) => key('child-' + i)));
  expect(await s.db.get('mappings', s.mapping.id)).toMatchObject({ state: 'current', lastAppliedRevision: 'p1' });
  expect(await s.db.nodesForMapping(s.mapping.id)).toHaveLength(s.desired.length);
});
