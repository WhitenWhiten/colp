import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceDigest } from '../src/site-adapters/source-db.js';
import { createManagedSaves, managedSlotKey } from '../src/site-adapters/managed-saves.js';
import { createManagedCopyClient, type ManagedDestination, type ManagedSaveReceipt, type ManagedSlot } from '../src/site-adapters/managed-client.js';
import type { NativeBinding, SaveEffect, SavePlan } from '../src/site-adapters/contracts.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const library = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
const parent: NativeBinding<'folder'> = { nativeId: 'root', deviceId: 'device', bindingId: 'root-proof', kind: 'folder', dateAdded: 1, proof: { kind: 'explicitAdoption', id: 'proof' } };
const slot: ManagedSlot = { kind: 'folder', source: { site: 'fixture.posts', identityVersion: 1, sourceAccount: 'reader', sourceCollectionId: 'saved' } };
async function fixture() {
  const db = createSourceDatabase(new IDBFactory());
  const sent: { action: string; input: unknown }[] = [];
  let projected = false, failReply = false, saved: ManagedSaveReceipt | null = null;
  const call = async <T>(action: 'managed.save' | 'managed.recover', input: unknown): Promise<T> => {
    sent.push({ action, input });
    if (action === 'managed.recover') return { receipt: saved } as T;
    const c = input as ManagedDestination['command'];
    saved = { version: 1, commandId: c.commandId, digest: sourceDigest(c), key: managedSlotKey(c.collectionId, c.slot), disposition: 'created',
      node: { nodeId: 'canonical-folder', parentId: c.parentId, title: c.title, url: null, revision: 'r2' } };
    if (failReply) throw new Error('sourceSyncPending');
    return saved as T;
  };
  const client = { profile: vi.fn(async () => {}), call };
  const wake = vi.fn();
  const managed = createManagedSaves(db, {
    destination: async () => ({ library, replicaId: 'replica', parentId: 'canonical-root', parentRevision: 'r1' }), slot: async () => slot,
    client: async () => client, wake,
    projection: async () => projected ? { native: { ...parent, bindingId: 'folder-command', nativeId: 'native-folder', proof: { kind: 'writeReceipt', id: 'managed:canonical-folder' } }, parentId: 'root' } : null,
  });
  const raw: PlannedNativeCommand = { commandId: 'folder-command', kind: 'folder', ownerId: 'reservation', logicalDigest: 'digest', connectionId: 'local-connection', parent, title: 'Saved', deviceId: 'device' };
  const command = await managed.prepare(raw, {} as SavePlan, {} as SaveEffect);
  return { db, managed, command, sent, wake, client, project: () => { projected = true; }, loseReply: () => { failReply = true; }, saved: () => saved };
}
test('a synced source create waits for ordinary projection and worker reconstruction reuses its persisted receipt', async () => {
  const f = await fixture(); try {
    const authorize = vi.fn(async () => {});
    expect(await f.managed.execute(f.command, authorize)).toEqual({ status: 'unknown', reason: 'sourceSyncPending' });
    expect(authorize).toHaveBeenCalledOnce(); expect(f.sent.map(s => s.action)).toEqual(['managed.save']);
    await f.db.close();
    f.project();
    expect(await f.managed.recover(f.command)).toMatchObject({ status: 'confirmed', native: { nativeId: 'native-folder' }, written: { parentId: 'root', title: 'Saved' } });
    expect(f.sent.map(s => s.action)).toEqual(['managed.save']);
    expect(f.wake).toHaveBeenCalled();
  } finally { await f.db.close(); }
});
test('a lost server reply recovers the original operation and never submits a replacement create', async () => {
  const f = await fixture(); try {
    f.loseReply();
    await expect(f.managed.execute(f.command, async () => {})).rejects.toThrow('sourceSyncPending');
    f.project();
    expect(await f.managed.recover(f.command)).toMatchObject({ status: 'confirmed' });
    expect(f.sent.map(s => s.action)).toEqual(['managed.save', 'managed.recover']);
    expect(f.sent[1]!.input).toEqual({ commandId: 'folder-command', digest: sourceDigest(f.command.managed!.command) });
  } finally { await f.db.close(); }
});
test('revocation after capability negotiation blocks dispatch and changed receipt payloads are never adopted', async () => {
  const f = await fixture(); try {
    await expect(f.managed.execute(f.command, async () => { throw new Error('sourceAuthorizationChanged'); })).rejects.toThrow('sourceAuthorizationChanged');
    expect(f.sent).toEqual([]);
    await f.managed.execute(f.command, async () => {});
    const tampered = { ...f.command, managed: { ...f.command.managed!, command: { ...f.command.managed!.command, title: 'Other' } } };
    await expect(f.managed.recover(tampered)).rejects.toThrow('sourceSyncInvalid');
  } finally { await f.db.close(); }
});
test('generic shared saves qualify capabilities independently from website-specific cloud archive profiles', async () => {
  const fetch = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'POST' ? { receipt: null } : { managedCopies: 1 }));
  const client = createManagedCopyClient({ origin: library.serverOrigin, fetch, headers: async () => ({}), assertCurrent: async () => {} });
  await client.profile(); expect(await client.call('managed.recover', { commandId: 'one', digest: 'digest' })).toEqual({ receipt: null });
  expect(fetch).toHaveBeenCalledTimes(2);
  let current = true;
  const fenced = createManagedCopyClient({ origin: library.serverOrigin, fetch, headers: async () => { current = false; return {}; }, assertCurrent: async () => { if (!current) throw new Error('changed'); } });
  await expect(fenced.call('managed.save', {})).rejects.toThrow('changed'); expect(fetch).toHaveBeenCalledTimes(2);
});
test('offline requests remain pending and an old server requires an update without sending a create', async () => {
  const offline = createManagedCopyClient({ origin: library.serverOrigin, fetch: async () => { throw new TypeError('Failed to fetch'); }, headers: async () => ({}), assertCurrent: async () => {} });
  await expect(offline.profile()).rejects.toThrow('sourceSyncPending');
  const old = createManagedCopyClient({ origin: library.serverOrigin, fetch: async () => Response.json({ version: 1 }), headers: async () => ({}), assertCurrent: async () => {} });
  await expect(old.profile()).rejects.toThrow('sourceSyncUpgradeRequired');
  const refreshing = createManagedCopyClient({ origin: library.serverOrigin, fetch: async () => Response.json({ error: { code: 'source_replica_unavailable' } }, { status: 403 }), headers: async () => ({}), assertCurrent: async () => {} });
  await expect(refreshing.call('managed.save', {})).rejects.toThrow('sourceSyncPending');
});
