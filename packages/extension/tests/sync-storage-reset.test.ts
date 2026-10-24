import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import {
  LOCAL_DATA_RESET_ARCHIVE, createSyncStorageReset, deleteSyncDatabase, readUnsentChanges, validSyncStorageResetRequest,
  type SyncStorageResetDeps,
} from '../src/sync-storage-reset.js';
import { DATABASE_NAME, DATABASE_VERSION, createSyncStateStore } from '../src/sync-state-store.js';
import { databaseNames, failingFactory, seedDatabase } from './sync-storage-fixtures.js';

/**
 * W2A-01: the exit when the sync database cannot be used. The unsent changes it can still read are saved
 * first, the browser moves to a new replica identity, and the database is deleted. If the copy cannot be
 * saved, nothing is deleted.
 */
const pending = (sequence: number) => ({ scopeKey: 'k', sequence, status: 'pending', opId: `op-${sequence}`,
  payload: { type: 'create_node', node: { title: `Bookmark ${sequence}`, url: `https://example.test/${sequence}` } } });
const terminal = (sequence: number) => ({ scopeKey: 'k', sequence, status: 'terminal', opId: `op-${sequence}` });
const PREVIEW = { kind: 'known.sync.storage.reset.preview' } as const;
const CONFIRM = { kind: 'known.sync.storage.reset.confirm', userGesture: true } as const;

function build(factory: IDBFactory, overrides: Partial<SyncStorageResetDeps> = {}, archive = new MemoryStorageArea()) {
  const calls: string[] = [];
  const store = createSyncStateStore({ indexedDB: factory });
  let clock = 1_700_000_000_000;
  const deps: SyncStorageResetDeps = {
    probe: () => store.storageState(), indexedDB: factory, archive, now: () => clock++,
    currentReplicaId: async () => 'replica-old',
    fence: async () => { calls.push('fence'); },
    rotateBinding: async () => { calls.push('rotate'); },
    forget: () => { calls.push('forget'); store.forgetStorage(); },
    resetRuntime: () => { calls.push('runtime'); },
    ensureScope: async () => { calls.push('ensure'); },
    deleteWaitMilliseconds: 60, fenceWaitMilliseconds: 40, ensureWaitMilliseconds: 40, ...overrides,
  };
  return { calls, archive, store, reset: createSyncStorageReset(deps) };
}
const archives = async (area: MemoryStorageArea) =>
  ((await area.get(LOCAL_DATA_RESET_ARCHIVE))[LOCAL_DATA_RESET_ARCHIVE] as { archives: Array<Record<string, unknown>> } | undefined)?.archives;

describe('Reset local sync data', () => {
  test('a database written by a newer extension: the unsent changes are saved, then the database is replaced', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1), terminal(2), pending(3)]);
    const { reset, calls, archive, store } = build(factory);
    assert.deepEqual(await reset.handle(PREVIEW), { ok: true,
      preview: { state: 'newer_version', code: 'future_schema', unsentChanges: 2, readable: true } });

    assert.deepEqual(await reset.handle(CONFIRM), { ok: true, result: 'reset', archivedChanges: 2, omittedChanges: 0 });
    // The old replica leaves the server while its Session exists, the identity rotates, then the database goes.
    assert.deepEqual(calls, ['fence', 'rotate', 'forget', 'forget', 'runtime', 'ensure']);
    const saved = await archives(archive);
    assert.equal(saved?.length, 1);
    assert.deepEqual(saved?.[0], { at: saved?.[0]?.at, state: 'newer_version', code: 'future_schema', readable: true,
      replicaId: 'replica-old', changes: [pending(1), pending(3)], omitted: 0 });
    // Nothing of the old database is left and the store works again at the current version.
    assert.deepEqual(await store.storageState(), { state: 'ok' });
    assert.equal((await store.open()).version, DATABASE_VERSION);
    assert.deepEqual(await readUnsentChanges(factory), { rows: [], readable: true });
    store.close();
  });

  test('a database that opens but lacks a store (read-only) is replaced the same way', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION, [pending(1)]);
    const { reset, store } = build(factory);
    assert.deepEqual(await reset.handle(CONFIRM), { ok: true, result: 'reset', archivedChanges: 1, omittedChanges: 0 });
    assert.deepEqual(await store.storageState(), { state: 'ok' });
    store.close();
  });

  test('a database that works is not reset: nothing is saved, rotated or deleted', async () => {
    const factory = new IDBFactory();
    const { reset, calls, archive, store } = build(factory);
    assert.deepEqual(await reset.handle(CONFIRM), { ok: false, code: 'storage_reset_not_needed' });
    assert.deepEqual(await reset.handle(PREVIEW), { ok: false, code: 'storage_reset_not_needed' });
    assert.deepEqual(calls, []);
    assert.equal(await archives(archive), undefined);
    assert.deepEqual(await databaseNames(factory), [DATABASE_NAME]);
    store.close();
  });

  test('if the copy cannot be saved, nothing is touched', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1)]);
    const full = { get: async () => ({}), set: async () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const { reset, calls } = build(factory, { archive: full });
    assert.deepEqual(await reset.handle(CONFIRM), { ok: false, code: 'archive_failed' });
    assert.deepEqual(calls, [], 'no fence, no rotation, no deletion');
    assert.equal((await factory.databases())[0]?.version, DATABASE_VERSION + 1);
  });

  test('with nothing to save, a full disk does not keep the person from resetting', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [terminal(1)]);
    const full = { get: async () => ({}), set: async () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const { reset, store } = build(factory, { archive: full });
    assert.deepEqual(await reset.handle(CONFIRM), { ok: true, result: 'reset', archivedChanges: 0, omittedChanges: 0 });
    assert.deepEqual(await store.storageState(), { state: 'ok' });
    store.close();
  });

  test('a database the browser cannot open at all has nothing to save and can still be deleted', async () => {
    const real = new IDBFactory(); await seedDatabase(real, DATABASE_VERSION + 1, [pending(1)]);
    const unreadable = { open: failingFactory('UnknownError').open, deleteDatabase: (name: string) => real.deleteDatabase(name) } as unknown as IDBFactory;
    const { reset, archive } = build(unreadable, { probe: async () => ({ state: 'unavailable', code: 'storage_unavailable' }) });
    assert.deepEqual(await reset.handle(PREVIEW), { ok: true,
      preview: { state: 'unavailable', code: 'storage_unavailable', unsentChanges: 0, readable: false } });
    assert.deepEqual(await reset.handle(CONFIRM), { ok: true, result: 'reset', archivedChanges: 0, omittedChanges: 0 });
    assert.equal(await archives(archive), undefined);
    assert.deepEqual(await databaseNames(real), []);
  });

  test('a fence that fails or hangs does not keep the person from resetting', async () => {
    for (const fence of [async () => { throw new Error('offline'); }, () => new Promise<void>(() => undefined)]) {
      const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1)]);
      const { reset, calls, store } = build(factory, { fence });
      assert.deepEqual(await reset.handle(CONFIRM), { ok: true, result: 'reset', archivedChanges: 1, omittedChanges: 0 });
      assert.deepEqual(calls, ['rotate', 'forget', 'forget', 'runtime', 'ensure']);
      store.close();
    }
  });

  test('if the identity cannot be rotated, the database stays (the copy is already saved)', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1)]);
    const { reset, archive, calls } = build(factory, { rotateBinding: async () => { throw new Error('stale_ref'); } });
    assert.deepEqual(await reset.handle(CONFIRM), { ok: false, code: 'stale_ref' });
    assert.deepEqual(calls, ['fence']);
    assert.equal((await archives(archive))?.length, 1);
    assert.equal((await factory.databases())[0]?.version, DATABASE_VERSION + 1);
  });

  test('a connection that will not close holds the deletion back and is reported, and the deletion finishes when it closes', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1)]);
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const { reset } = build(factory);
    assert.deepEqual(await reset.handle(CONFIRM), { ok: false, code: 'storage_reset_blocked' });
    holder.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await databaseNames(factory), [], 'the pending deletion completed once nothing held the database');
  });

  test('the newest three copies are kept, oldest dropped', async () => {
    const archive = new MemoryStorageArea();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1, [pending(attempt)]);
      const { reset, store } = build(factory, {}, archive);
      assert.equal((await reset.handle(CONFIRM)).ok, true);
      store.close();
    }
    const kept = await archives(archive);
    assert.deepEqual(kept?.map(entry => (entry.changes as Array<{ sequence: number }>)[0]?.sequence), [2, 3, 4]);
  });

  test('deleting a database nobody holds succeeds, and one that does not exist is not an error', async () => {
    const factory = new IDBFactory();
    await deleteSyncDatabase(factory, 20);
    await seedDatabase(factory, DATABASE_VERSION, []);
    await deleteSyncDatabase(factory, 20);
    assert.deepEqual(await databaseNames(factory), []);
  });

  test('reading the unsent changes never creates the database', async () => {
    const factory = new IDBFactory();
    assert.deepEqual(await readUnsentChanges(factory), { rows: [], readable: true });
    assert.deepEqual(await databaseNames(factory), []);
  });
});

describe('the reset message', () => {
  test('only the exact preview and confirm requests are accepted', () => {
    assert.equal(validSyncStorageResetRequest(PREVIEW), true);
    assert.equal(validSyncStorageResetRequest(CONFIRM), true);
    assert.equal(validSyncStorageResetRequest({ kind: 'known.sync.storage.reset.confirm' }), false, 'no gesture');
    assert.equal(validSyncStorageResetRequest({ kind: 'known.sync.storage.reset.confirm', userGesture: false }), false);
    assert.equal(validSyncStorageResetRequest({ ...CONFIRM, extra: 1 }), false);
    assert.equal(validSyncStorageResetRequest({ ...PREVIEW, userGesture: true }), false);
    assert.equal(validSyncStorageResetRequest({ kind: 'known.sync.storage.reset' }), false);
    assert.equal(validSyncStorageResetRequest(null), false);
    assert.equal(validSyncStorageResetRequest([]), false);
  });
});

describe('the database is deleted in exactly one place', () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(?:ts|tsx|js|mjs)$/u.test(name) ? [path] : [];
  });
  test('only the controlled reset module calls deleteDatabase; the store never does', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const callers = sources(root).filter(file => /\bdeleteDatabase\(/u.test(readFileSync(file, 'utf8'))).map(file => relative(root, file));
    assert.deepEqual(callers, ['sync-storage-reset.ts']);
  });
});

describe('the production wiring', () => {
  afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  test('it rotates the replica identity through the credential store, with a new id and generation 1', async () => {
    vi.resetModules();
    const calls: unknown[][] = [];
    // The production reset works on the worker's own database; make it a newer one.
    const factory = indexedDB as unknown as IDBFactory;
    await new Promise<void>((resolve, reject) => { const request = factory.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    await seedDatabase(factory, DATABASE_VERSION + 1, [pending(1)]);
    const syncState = createSyncStateStore({ indexedDB: factory });
    const binding = { replicaId: 'replica-old', browserProfileId: 'profile-a', generation: '3' };
    vi.doMock('../src/sw/runtime.js', () => ({ syncState,
      store: { loadBinding: async () => binding, fence: { capture: async () => ({ generation: 7 }) },
        replaceBindingForRebuild: async (...args: unknown[]) => { calls.push(args); } } }));
    vi.doMock('../src/sw/scope-rebuild.js', () => ({ fenceCurrentReplica: async () => undefined, resetReplicaRuntime: () => undefined,
      ensureReplacedScope: async () => undefined }));
    vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() } });
    const { syncStorageReset } = await import('../src/sw/storage-reset.js');
    const result = await syncStorageReset().handle(CONFIRM);
    assert.deepEqual(result, { ok: true, result: 'reset', archivedChanges: 1, omittedChanges: 0 });
    assert.equal(calls.length, 1);
    const [generation, oldReplicaId, next] = calls[0]!;
    assert.equal(generation, 7);
    assert.equal(oldReplicaId, 'replica-old');
    assert.match((next as { replicaId: string }).replicaId, /^replica-[0-9a-f-]{36}$/u);
    assert.equal((next as { generation: string }).generation, '1');
    assert.equal((next as { browserProfileId: string }).browserProfileId, 'profile-a');
    syncState.close();
  });
});
