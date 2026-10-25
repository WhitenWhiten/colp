import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSemanticJobs, type SemanticInput, type SemanticJob, type SemanticPorts } from '../src/site-adapters/semantic-jobs.js';
import type { NativeBinding } from '../src/site-adapters/contracts.js';
const folder: NativeBinding<'folder'> = { nativeId: 'semantic-folder', bindingId: 'folder-proof', kind: 'folder', dateAdded: 10, deviceId: 'device', proof: { kind: 'explicitAdoption', id: 'proof' } };
const native: NativeBinding<'bookmark'> = { ...folder, nativeId: 'semantic-bookmark', bindingId: 'bookmark-proof', kind: 'bookmark' };
const input = (itemId = 'post:one'): SemanticInput => ({ scopeId: 'library-a', scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library-a', authorityGeneration: 1 },
  content: { site: 'fixture.posts', identityVersion: 1, itemId, accountId: null }, title: itemId, url: `https://posts.test/${itemId}`,
  source: { connectionId: 'source-one', policyRevision: 1, installationGeneration: 1, sourceSessionGeneration: 1 } });
async function fixture() {
  const db = createSourceDatabase(new IDBFactory());
  const ports: SemanticPorts = {
    authorize: vi.fn(async () => {}), existing: vi.fn<SemanticPorts['existing']>(async () => ({ status: 'missing' })), claim: vi.fn<SemanticPorts['claim']>(async () => ({ status: 'claimed' })), release: vi.fn(async () => {}),
    classify: vi.fn(async () => ({ folder, tags: [], destinationDigest: 'allowed' })),
    prepare: vi.fn<SemanticPorts['prepare']>(async job => ({ commandId: job.id, ownerId: job.id, connectionId: job.sources[0]!.connectionId, kind: 'bookmark',
      parent: folder, title: job.title, deviceId: 'device', logicalDigest: 'digest' })),
    execute: vi.fn<SemanticPorts['execute']>(async () => ({ status: 'confirmed', native, written: { title: 'Saved', parentId: folder.nativeId, url: input().url } })),
    finish: vi.fn(async () => {}), schedule: vi.fn(),
  };
  const jobs = createSemanticJobs(db, ports);
  const first = async () => (await db.transaction(['semanticJobs'], 'readonly', tx => new Promise<SemanticJob[]>(resolve => {
    const r = tx.objectStore('semanticJobs').getAll(); r.onsuccess = () => resolve(r.result);
  })))[0]!;
  return { db, ports, jobs, first };
}
test('two collection discoveries and two source accounts share one semantic task within a library', async () => {
  const f = await fixture(); try {
    await f.jobs.enqueue(input()); await f.jobs.enqueue(input());
    await f.jobs.enqueue({ ...input(), source: { ...input().source, connectionId: 'source-two' } });
    await f.jobs.wake();
    expect(f.ports.classify).toHaveBeenCalledTimes(1); expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(await f.jobs.status('source-one')).toMatchObject({ completed: 1, pending: 0 });
    expect(await f.jobs.status('source-two')).toMatchObject({ completed: 1, pending: 0 });
  } finally { await f.db.close(); }
});
test('classification failure preserves source data and an explicit retry classifies only the missing semantic copy', async () => {
  const f = await fixture(); try {
    await f.db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').put({ state: 'active', nativeId: 'source-bookmark' }, sourceKey('source-one', 'post:one')); });
    vi.mocked(f.ports.classify).mockRejectedValueOnce(new Error('providerFailed'));
    await f.jobs.enqueue(input()); await f.jobs.wake();
    expect(await f.jobs.status('source-one')).toMatchObject({ attention: 1 }); expect(f.ports.execute).not.toHaveBeenCalled();
    expect(await f.db.read('representations', sourceKey('source-one', 'post:one'))).toEqual({ state: 'active', nativeId: 'source-bookmark' });
    const before = await f.first(); await f.jobs.retry(before.id, 'source-one'); await f.jobs.wake();
    expect(await f.jobs.status('source-one')).toMatchObject({ completed: 1 });
    expect((await f.first()).providerCommandId).not.toBe(before.providerCommandId); expect(f.ports.execute).toHaveBeenCalledTimes(1);
  } finally { await f.db.close(); }
});
test('a pending shared save recovers its exact command without repeating classification', async () => {
  const f = await fixture(); try {
    vi.mocked(f.ports.execute).mockResolvedValueOnce({ status: 'unknown', reason: 'sourceSyncPending' });
    await f.jobs.enqueue(input()); await f.jobs.wake(); const pending = await f.first();
    expect(pending).toMatchObject({ state: 'pending', step: 'saving', reason: 'sourceSyncPending' });
    await f.jobs.wake();
    expect(f.ports.classify).toHaveBeenCalledTimes(1); expect(f.ports.prepare).toHaveBeenCalledTimes(1);
    expect(f.ports.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: pending.command }), true);
    expect(await f.jobs.status('source-one')).toMatchObject({ completed: 1 });
  } finally { await f.db.close(); }
});
test('worker loss during classification becomes attention instead of another provider call', async () => {
  const f = await fixture(); try {
    await f.jobs.enqueue(input()); const job = await f.first();
    await f.db.transaction(['semanticJobs'], 'readwrite', async tx => { tx.objectStore('semanticJobs').put({ ...job, step: 'classifying' }, job.id); });
    await f.jobs.wake();
    expect(await f.first()).toMatchObject({ state: 'attention', reason: 'semanticResultUnknown' });
    expect(f.ports.classify).not.toHaveBeenCalled(); expect(f.ports.execute).not.toHaveBeenCalled();
  } finally { await f.db.close(); }
});
test('existing semantic copies are reused and suppressed copies never dispatch a model or create', async () => {
  const f = await fixture(); try {
    vi.mocked(f.ports.existing).mockResolvedValueOnce({ status: 'saved', native, written: { title: 'Saved', parentId: folder.nativeId, url: input().url } })
      .mockResolvedValueOnce({ status: 'suppressed' });
    await f.jobs.enqueue(input()); await f.jobs.enqueue(input('post:two')); await f.jobs.wake();
    expect(await f.jobs.status('source-one')).toMatchObject({ completed: 1, suppressed: 1 });
    expect(f.ports.classify).not.toHaveBeenCalled(); expect(f.ports.execute).not.toHaveBeenCalled();
  } finally { await f.db.close(); }
});
test('a retry fences a late classification result and only the new attempt may save', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.ports.classify).mockImplementationOnce(async () => { await held; return { folder, tags: [], destinationDigest: 'allowed' }; });
    await f.jobs.enqueue(input()); const running = f.jobs.wake();
    await vi.waitFor(() => expect(f.ports.classify).toHaveBeenCalledTimes(1));
    const old = await f.first(); await f.jobs.retry(old.id, 'source-one'); release(); await running;
    expect(f.ports.execute).not.toHaveBeenCalled();
    await f.jobs.wake(); expect(f.ports.classify).toHaveBeenCalledTimes(2); expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(await f.jobs.status('source-one')).toMatchObject({ completed: 1 });
  } finally { release?.(); await f.db.close(); }
});
test('private accounts and destination libraries keep separate tasks', async () => {
  const f = await fixture(); try {
    await f.jobs.enqueue(input()); await f.jobs.enqueue({ ...input(), scopeId: 'library-b' });
    await f.jobs.enqueue({ ...input(), content: { ...input().content, accountId: 'private' } });
    await f.jobs.wake(); expect(f.ports.classify).toHaveBeenCalledTimes(3); expect(f.ports.execute).toHaveBeenCalledTimes(3);
  } finally { await f.db.close(); }
});
