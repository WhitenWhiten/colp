import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { NativeExecutor } from '../src/bookmark-subscriptions/native.js';
import type { LocalMapping, NativeOperation } from '../src/bookmark-subscriptions/local-types.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore, native: undefined as unknown as NativeExecutor }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({ get subscriptionNative() { return state.native; } }));
import { subscriptionEvent } from '../src/bookmark-subscriptions/events.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { database, row, root, leaf, owned } from './bookmark-subscriptions-fixture.js';
import { positionedNativeFixture } from './bookmark-subscriptions-position-fixture.js';

let fixture: ReturnType<typeof positionedNativeFixture>, mapping: LocalMapping, rootId: string;
beforeEach(async () => {
  state.db = database(); fixture = positionedNativeFixture();
  rootId = (await fixture.api.create({ parentId: 'bar', title: root.title })).id;
  for (const title of ['A', 'B']) await fixture.api.create({ parentId: 'bar', title });
  mapping = { ...row(), rootNativeId: rootId, state: 'current' };
  await state.db.put('mappings', mapping); await state.db.put('nodes', owned(mapping, root, rootId));
  state.native = createNativeExecutor(state.db, fixture.api);
});
afterEach(async () => { vi.restoreAllMocks(); await state.db.close(); });

it('converts downward insertion once and consumes its callback before the promise resolves', async () => {
  const rawMove = fixture.api.move;
  const indices: (number | undefined)[] = [];
  fixture.api.move = async (id, destination) => {
    indices.push(destination.index);
    const before = (await fixture.api.get(id))[0]!; const result = await rawMove(id, destination);
    await subscriptionEvent({ kind: 'moved', nativeId: id, move: { oldParentId: before.parentId!, oldIndex: before.index!, parentId: result.parentId!, index: result.index! } });
    return result;
  };
  for (const index of [2, 0, 1]) {
    expect(await state.native.updateRoot(mapping, (await state.db.nodeForNative(rootId))!, 'Source', 'bar', index)).toBe(index);
    expect((await fixture.api.get(rootId))[0]!.index).toBe(index);
    expect((await state.db.nodeForNative(rootId))!.index).toBe(index);
  }
  expect(indices).toEqual([3, 0, 2]);
  expect(await state.db.get('mappings', mapping.id)).toMatchObject({ enabled: true, applyEpoch: 1, state: 'current' });
  expect(await state.db.all('diagnostics')).toEqual([]);
  expect((await state.db.all('operations')).every(o => o.eventConsumed && o.settled)).toBe(true);
});

it('orders owned children without reading all destination siblings per move', async () => {
  const ids = [];
  for (const name of ['one', 'two', 'three']) ids.push((await fixture.api.create({ parentId: rootId, title: name, url: 'https://example.test/' + name })).id);
  const node = leaf('one'); const evidence = owned(mapping, node, ids[0]!, rootId); await state.db.put('nodes', evidence);
  const children = vi.spyOn(fixture.api, 'getChildren');
  await state.native.update(mapping, evidence, { ...node, index: 2 }, rootId);
  expect((await fixture.api.get(ids[0]!))[0]!.index).toBe(2);
  expect((await state.db.nodeForNative(ids[0]!))!.index).toBe(2);
  expect(children).not.toHaveBeenCalled();
});

it('restores owned and personal nodes using final positions', async () => {
  await state.native.restorePlacement(mapping, (await state.db.nodeForNative(rootId))!, 'bar', 2);
  expect((await fixture.api.get(rootId))[0]!.index).toBe(2);
  const personal = (await fixture.api.getChildren('bar'))[0]!;
  await state.native.restorePersonal(mapping, personal.id, 'bar', 2);
  expect((await fixture.api.get(personal.id))[0]!.index).toBe(2);
  expect(await state.db.get('exclusions', personal.id)).toBeUndefined();
});

it('settles the actual create receipt after interruption instead of the unclamped desired index', async () => {
  const put = state.db.put; let fail = true;
  vi.spyOn(state.db, 'put').mockImplementation(async (name, value) => { if (name === 'nodes' && fail) { fail = false; throw new Error('worker stopped before ownership'); } return put(name, value); });
  await expect(state.native.create(mapping, { ...root, index: 20 }, 'bar')).rejects.toThrow('worker stopped');
  const [operation] = await state.db.pendingOperations();
  expect(operation).toMatchObject({ phase: 'received', targetIndex: 3, resultIndex: 3, resultParentNativeId: 'bar', node: { index: 20 } });
  const calls = fixture.calls.length;
  await createNativeExecutor(state.db, fixture.api).recover(mapping);
  expect((await state.db.nodeForNative(operation!.resultId!))!.index).toBe(3);
  expect((await state.db.nodeForNative(operation!.resultId!))!.node.index).toBe(3);
  expect(await state.db.pendingOperations()).toEqual([]); expect(fixture.calls).toHaveLength(calls);
});

it('recovers an applied move after a lost reply without issuing another move', async () => {
  const rawMove = fixture.api.move;
  fixture.api.move = async (id, destination) => { await rawMove(id, destination); throw new Error('reply_lost'); };
  await expect(state.native.updateRoot(mapping, (await state.db.nodeForNative(rootId))!, 'Source', 'bar', 2)).rejects.toThrow('reply_lost');
  expect(await state.db.pendingOperations()).toMatchObject([{ phase: 'issued', targetIndex: 2 }]);
  const calls = fixture.calls.length;
  await createNativeExecutor(state.db, fixture.api).recover(mapping);
  expect((await state.db.nodeForNative(rootId))!.index).toBe(2);
  expect(await state.db.pendingOperations()).toEqual([]); expect(fixture.calls).toHaveLength(calls);
});

it('persists actual returned placement and uses it to recognize the delayed event', async () => {
  const rawMove = fixture.api.move;
  fixture.api.move = (id, destination) => rawMove(id, { ...destination, index: 2 });
  expect(await state.native.updateRoot(mapping, (await state.db.nodeForNative(rootId))!, 'Source', 'bar', 2)).toBe(1);
  const [operation] = await state.db.all('operations');
  expect(operation).toMatchObject({ targetIndex: 2, resultIndex: 1, resultParentNativeId: 'bar' });
  expect((await state.db.nodeForNative(rootId))!.index).toBe(1);
  await subscriptionEvent({ kind: 'moved', nativeId: rootId, move: { oldParentId: 'bar', oldIndex: 0, parentId: 'bar', index: 1 } });
  expect((await state.db.get('operations', operation!.id))!.eventConsumed).toBe(true);
  expect((await state.db.get('mappings', mapping.id))!.applyEpoch).toBe(1);
  expect(await state.db.all('diagnostics')).toEqual([]);
});

it('keeps old received journal records readable without inventing a new native mutation', async () => {
  const operation: NativeOperation = { id: crypto.randomUUID(), mappingId: mapping.id, generation: 'g1', applyEpoch: 1, kind: 'move', phase: 'received', nativeId: rootId, resultId: rootId, node: root, parentNativeId: 'bar', targetIndex: 0, createdAt: Date.now() };
  await state.db.put('operations', operation);
  const calls = fixture.calls.length;
  await state.native.recover(mapping);
  expect(await state.db.pendingOperations()).toEqual([]); expect(fixture.calls).toHaveLength(calls);
});
