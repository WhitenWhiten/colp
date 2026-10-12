import { IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { preservationKey } from '../src/bookmark-subscriptions/preservation-journal.js';
import { exclusionIds } from '../src/bookmark-subscriptions/guards.js';
import { database, nativeFixture, row, scope } from './bookmark-subscriptions-fixture.js';

beforeEach(() => { state.db = database(); });
afterEach(async () => { vi.restoreAllMocks(); await state.db.close(); });
async function setup() {
  const mapping = row(), fixture = nativeFixture();
  await state.db.put('mappings', mapping);
  return { mapping, fixture, native: createNativeExecutor(state.db, fixture.api) };
}
function failAfterReceipt() {
  const change = state.db.changeOperation.bind(state.db);
  vi.spyOn(state.db, 'changeOperation').mockImplementation(async (id, patch) => {
    const saved = await change(id, patch);
    if (patch.phase === 'received') throw new Error('interrupted_receipt');
    return saved;
  });
}

test.each(['received', 'exclusions', 'meta', 'operations'] as const)('restarts safely after interruption at preservation %s without a second native create', async point => {
  const s = await setup();
  if (point === 'received') failAfterReceipt();
  else {
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const record = value as { id: string; settled?: boolean };
      if (this.name === point && (point !== 'operations' || record.settled === true)) throw new Error('interrupted_' + point);
      return put.call(this, value, key);
    });
  }
  await expect(s.native.preservation(s.mapping)).rejects.toThrow(/interrupted_/);
  vi.restoreAllMocks();
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.pendingOperations()).toMatchObject([{ phase: 'received', purpose: 'preservation', localKey: preservationKey(scope), resultId: '1' }]);
  // Every intermediate IDB write rolls back; the receipt still excludes the directory.
  expect(await state.db.get('exclusions', '1')).toBeUndefined();
  expect(await state.db.get('meta', preservationKey(scope))).toBeUndefined();
  expect(await exclusionIds()).toContain('1');
  await state.db.close();
  const restarted = createNativeExecutor(state.db, s.fixture.api);
  await restarted.recover(s.mapping);
  await restarted.recover(s.mapping);
  expect(await restarted.preservation(s.mapping)).toBe('1');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.pendingOperations()).toEqual([]);
  expect(await state.db.get('meta', preservationKey(scope))).toMatchObject({ value: '1' });
  expect(await state.db.get('exclusions', '1')).toMatchObject({ nativeId: '1', reason: 'preserved', accountId: scope.accountId });
  expect(await exclusionIds()).toContain('1');
});

test('a legacy received directory is recovered by recorded identity even after a user rename', async () => {
  const s = await setup(); failAfterReceipt();
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('interrupted_receipt');
  vi.restoreAllMocks();
  const op = (await state.db.pendingOperations())[0]!;
  await state.db.put('operations', { ...op, purpose: undefined, localKey: undefined });
  s.fixture.nodes.get('1')!.title = 'My renamed folder';
  await state.db.close();
  const restarted = createNativeExecutor(state.db, s.fixture.api);
  await restarted.recover(s.mapping);
  expect(await restarted.preservation(s.mapping)).toBe('1');
  expect(s.fixture.nodes.get('1')!.title).toBe('My renamed folder');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.get('operations', op.id)).toMatchObject({ purpose: 'preservation', localKey: preservationKey(scope), settled: true });
});

test('a second mapping recovers the account directory receipt before it creates any folder', async () => {
  const s = await setup(); failAfterReceipt();
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('interrupted_receipt');
  vi.restoreAllMocks(); await state.db.close();
  const second = { ...row(), id: crypto.randomUUID() }; second.mapping = { ...second.mapping, mappingId: second.id };
  await state.db.put('mappings', second);
  expect(await createNativeExecutor(state.db, s.fixture.api).preservation(second)).toBe('1');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.pendingOperations()).toEqual([]);
});

test('an issued call with a lost receipt quarantines candidates and blocks another mapping from guessing or duplicating', async () => {
  const s = await setup();
  s.fixture.nodes.set('preexisting', { id: 'preexisting', parentId: 'bar', title: 'Know-N backup' });
  const create = s.fixture.api.create.bind(s.fixture.api);
  vi.spyOn(s.fixture.api, 'create').mockImplementationOnce(async input => { await create(input); throw new Error('lost_callback'); });
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('lost_callback');
  await state.db.close();
  const second = { ...row(), id: crypto.randomUUID() }; second.mapping = { ...second.mapping, mappingId: second.id };
  await state.db.put('mappings', second);
  const restarted = createNativeExecutor(state.db, s.fixture.api);
  await expect(restarted.preservation(second)).rejects.toThrow('recovery_identity_uncertain');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.get('meta', preservationKey(scope))).toBeUndefined();
  expect(await state.db.get('exclusions', '1')).toMatchObject({ reason: 'quarantine' });
  expect(await state.db.get('exclusions', 'preexisting')).toBeUndefined();
  expect(await state.db.pendingOperations()).toMatchObject([{ phase: 'issued' }]);
});

test('an unissued prepared directory intent can be retired before a single real create', async () => {
  const s = await setup(), change = state.db.changeOperation.bind(state.db);
  vi.spyOn(state.db, 'changeOperation').mockImplementation(async (id, patch) => {
    if (patch.phase === 'issued') throw new Error('interrupted_before_issue');
    return change(id, patch);
  });
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('interrupted_before_issue');
  expect(s.fixture.calls).toEqual([]);
  vi.restoreAllMocks(); await state.db.close();
  expect(await createNativeExecutor(state.db, s.fixture.api).preservation(s.mapping)).toBe('1');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.pendingOperations()).toEqual([]);
});

test('a late received directory is durably excluded before rejecting an expired apply epoch', async () => {
  const s = await setup(), create = s.fixture.api.create.bind(s.fixture.api);
  vi.spyOn(s.fixture.api, 'create').mockImplementationOnce(async input => {
    const folder = await create(input);
    await state.db.changeMapping(s.mapping.id, m => ({ ...m, applyEpoch: m.applyEpoch + 1, enabled: false, cleanup: true }));
    return folder;
  });
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('apply_epoch_changed');
  expect(await state.db.pendingOperations()).toEqual([]);
  expect(await state.db.get('exclusions', '1')).toMatchObject({ reason: 'preserved' });
  expect(await s.native.preservation((await state.db.get('mappings', s.mapping.id))!)).toBe('1');
  expect(s.fixture.calls).toEqual(['create:1']);
});

test('different accounts cannot reuse or settle each other pending preservation directories', async () => {
  const s = await setup(); failAfterReceipt();
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('interrupted_receipt');
  vi.restoreAllMocks();
  const foreign = { ...row(), id: crypto.randomUUID(), scope: { ...scope, accountId: 'another-account' } };
  foreign.mapping = { ...foreign.mapping, mappingId: foreign.id };
  await state.db.put('mappings', foreign);
  expect(await s.native.preservation(foreign)).toBe('2');
  expect(await state.db.get('meta', preservationKey(scope))).toBeUndefined();
  expect(await state.db.pendingOperations()).toHaveLength(1);
  expect(await s.native.preservation(s.mapping)).toBe('1');
  expect(await state.db.get('exclusions', '1')).toMatchObject({ accountId: scope.accountId });
  expect(await state.db.get('exclusions', '2')).toMatchObject({ accountId: 'another-account' });
  expect(s.fixture.calls).toEqual(['create:1', 'create:2']);
});

test.each(['received', 'issued'] as const)('a replaced mapping generation cannot adopt an old %s directory or create another', async phase => {
  const s = await setup();
  if (phase === 'received') failAfterReceipt();
  else {
    const create = s.fixture.api.create.bind(s.fixture.api);
    vi.spyOn(s.fixture.api, 'create').mockImplementationOnce(async input => { await create(input); throw new Error('interrupted_receipt'); });
  }
  await expect(s.native.preservation(s.mapping)).rejects.toThrow('interrupted_receipt');
  vi.restoreAllMocks();
  const replacement = await state.db.changeMapping(s.mapping.id, m => ({ ...m, mapping: { ...m.mapping, generation: 'g2' } }));
  await expect(s.native.preservation(replacement)).rejects.toThrow('generation_mismatch');
  expect(s.fixture.calls).toEqual(['create:1']);
  expect(await state.db.get('meta', preservationKey(scope))).toBeUndefined();
  expect(await state.db.pendingOperations()).toHaveLength(1);
});

test('a regular local folder receipt is never promoted into a preservation directory', async () => {
  const s = await setup(); failAfterReceipt();
  await expect(s.native.createLocal(s.mapping, 'mount-parent', { parentId: 'bar', title: 'Know-N backup' })).rejects.toThrow('interrupted_receipt');
  vi.restoreAllMocks();
  await s.native.recover(s.mapping);
  expect(await state.db.get('meta', preservationKey(scope))).toBeUndefined();
  expect(await s.native.preservation(s.mapping)).toBe('2');
  expect(await state.db.get('exclusions', '1')).toBeUndefined();
  expect(await state.db.get('exclusions', '2')).toMatchObject({ reason: 'preserved' });
});
