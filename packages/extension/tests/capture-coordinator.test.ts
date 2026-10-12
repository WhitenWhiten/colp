import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { createCaptureCoordinator, type CapturePorts } from '../src/capture/coordinator.js';
import { isActionPopup, validCaptureRequest } from '../src/capture/messages.js';
import { task, location } from './fixtures/capture.js';

function harness() {
  const store = createCaptureStore(new IDBFactory());
  const ports: CapturePorts = {
    store, now: () => 10, assertCurrent: async () => undefined,
    existence: async () => ({ kind: 'not-found', exact: [], similar: [],
      coverage: { local: 'complete', cloud: 'complete', collectionIds: ['c'], checkedAt: 1, stale: false } }),
    create: vi.fn<CapturePorts['create']>(async (_task, reserved) => { await reserved('intent'); return { nativeId: '1', location, sync: 'pending' }; }),
    receipt: async () => null,
  };
  return { store, ports, coordinator: createCaptureCoordinator(ports) };
}

describe('durable capture coordination', () => {
  it.each([
    { accountId: null, collectionId: null },
    { accountId: 'a', collectionId: null },
  ])('saves a local batch without cloud consent when no collection is connected: %j', async identity => {
    const { store, ports } = harness();
    const localTask = { ...task, source: 'batch' as const, scope: { ...task.scope, ...identity }, allowUnverifiedCloud: false };
    ports.existence = async () => ({ kind: 'unavailable', exact: [], similar: [],
      coverage: { local: 'complete', cloud: 'unavailable', collectionIds: [], checkedAt: 1, stale: false } });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start(localTask);
    expect((await coordinator.resume(localTask.scope, localTask.captureId)).save).toBe('local-saved');
    expect(ports.create).toHaveBeenCalledOnce();
    await store.close();
  });
  it('still requires local duplicate-check access for a signed-out batch', async () => {
    const { store, ports } = harness();
    const localTask = { ...task, source: 'batch' as const, scope: { ...task.scope, accountId: null, collectionId: null }, allowUnverifiedCloud: false };
    ports.existence = async () => ({ kind: 'unavailable', exact: [], similar: [],
      coverage: { local: 'unavailable', cloud: 'unavailable', collectionIds: [], checkedAt: 1, stale: false } });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start(localTask);
    expect(await coordinator.resume(localTask.scope, localTask.captureId)).toMatchObject({ save: 'failed', reason: 'existence_unavailable' });
    expect(ports.create).not.toHaveBeenCalled();
    await store.close();
  });
  it('saves into a connected browser without waiting for cloud confirmation or consent', async () => {
    const { store, ports } = harness();
    ports.existence = async () => ({ kind: 'not-found', exact: [], similar: [],
      coverage: { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: 1, stale: false } });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start({ ...task, allowUnverifiedCloud: false });
    expect((await coordinator.resume(task.scope, task.captureId)).save).toBe('local-saved');
    expect(ports.create).toHaveBeenCalledOnce();
    await store.close();
  });
  it('merges concurrent active actions and retains command aliases after completion', async () => {
    const { store, ports, coordinator } = harness();
    const [first, second] = await Promise.all([coordinator.start(task), coordinator.start({ ...task, captureId: 'c2', commandId: 'cmd2' })]);
    expect(second.captureId).toBe(first.captureId);
    const results = await Promise.all([coordinator.resume(task.scope, first.captureId), coordinator.resume(task.scope, second.captureId)]);
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(results[0]?.save).toBe('local-saved');
    const replay = await coordinator.start({ ...task, captureId: 'new-id', commandId: 'cmd2' });
    expect(replay.captureId).toBe(first.captureId);
    expect(await store.get({ ...task.scope, accountId: 'other' }, first.captureId)).toBeNull();
    await store.close();
  });
  it('publishes the native receipt before optional favicon work completes', async () => {
    const { store, ports, coordinator } = harness();
    let release: (() => void) | undefined, confirmed: (() => void) | undefined;
    const done = new Promise<void>(resolve => { confirmed = resolve; });
    ports.create = async (_task, reserve, saved) => {
      await reserve('intent'); const receipt = { nativeId: '1', location, sync: 'pending' as const };
      await saved(receipt); confirmed!();
      await new Promise<void>(resolve => { release = resolve; }); return receipt;
    };
    await coordinator.start(task); const running = coordinator.resume(task.scope, task.captureId);
    await done; expect((await store.get(task.scope, task.captureId))?.save).toBe('local-saved');
    release!(); expect((await running).save).toBe('local-saved'); await store.close();
  });
  it('recovers a lost create response with the old intent after coordinator restart', async () => {
    const { store, ports, coordinator } = harness();
    ports.create = vi.fn(async (_task, reserved) => { await reserved('original-intent'); throw new Error('worker terminated'); });
    await coordinator.start(task);
    expect((await coordinator.resume(task.scope, task.captureId)).save).toBe('unknown');
    const rebooted = createCaptureCoordinator({ ...ports, receipt: async record => {
      expect(record.nativeIntentId).toBe('original-intent'); return { nativeId: '1', location, sync: 'pending', savedAt: 2 };
    } });
    expect(await rebooted.resume(task.scope, task.captureId)).toMatchObject({ save: 'local-saved', savedAt: 2, updatedAt: 10 });
    expect(ports.create).toHaveBeenCalledTimes(1);
    await store.close();
  });
  it('does not recreate unknown outcomes without receipt proof', async () => {
    const { store, ports, coordinator } = harness();
    await coordinator.start({ ...task, save: 'unknown', nativeIntentId: 'lost' });
    expect((await coordinator.resume(task.scope, task.captureId)).save).toBe('unknown');
    expect(ports.create).not.toHaveBeenCalled();
    await store.close();
  });
  it('stops at known existing locations without creating a bookmark', async () => {
    const { store, ports } = harness();
    const original = ports.existence;
    ports.existence = async task => ({ ...await original(task), kind: 'local', exact: [location] });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start(task);
    expect((await coordinator.resume(task.scope, task.captureId)).disposition).toBe('existing');
    expect(ports.create).not.toHaveBeenCalled();
    await store.close();
  });
  it('enforces revision CAS and stable bounded pagination', async () => {
    const { store } = harness();
    for (let i = 0; i < 55; i++) await store.claim({ ...task, automaticIntent: false, classification: 'none',
      captureId: `c${i}`, commandId: `cmd${i}`, url: `${task.url}-${i}`, createdAt: i });
    const page = await store.list(task.scope);
    expect(page).toHaveLength(50);
    const last = page.at(-1)!;
    expect(await store.list(task.scope, [last.createdAt, last.captureId])).toHaveLength(5);
    const first = page[0]!;
    await store.update({ ...first, revision: 1 }, 0);
    await expect(store.update({ ...first, revision: 1 }, 0)).rejects.toThrow('capture_revision_conflict');
    await store.close();
  });
  it('retains owner history after re-login while blocking a new create over an old unknown outcome', async () => {
    const { store, coordinator } = harness();
    await coordinator.start({ ...task, save: 'unknown', nativeIntentId: 'prior' });
    const nextScope = { ...task.scope, authorityGeneration: 2 };
    expect(await store.get(nextScope, task.captureId)).toBeNull();
    expect((await store.getForOwner(nextScope, task.captureId))?.save).toBe('unknown');
    await expect(store.claim({ ...task, scope: nextScope, captureId: 'new-capture', commandId: 'new-command' })).rejects.toThrow('capture_prior_result_unknown');
    expect(await store.listForOwner({ ...nextScope, accountId: 'other' })).toEqual([]);
    await store.close();
  });
  it('prunes only expired settled records and never pending recovery or feedback', async () => {
    const { store } = harness();
    await store.claim({ ...task, createdAt: 0, save: 'local-saved', classification: 'none', sync: 'local-only', automaticIntent: false });
    await store.claim({ ...task, captureId: 'pending', commandId: 'pending', url: 'https://pending.example', createdAt: 0, save: 'unknown' });
    expect(await store.prune(task.scope, 100 * 86400000)).toBe(1);
    expect(await store.get(task.scope, task.captureId)).toBeNull();
    expect((await store.get(task.scope, 'pending'))?.save).toBe('unknown');
    await store.close();
  });
});

describe('capture admission', () => {
  it('requires a real popup document, not a tab opened at popup.html', async () => {
    const url = 'chrome-extension://extension/popup.html?surface=12345678-1234-4123-8123-123456789abc';
    vi.stubGlobal('chrome', { runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`,
      getContexts: async () => [{ contextType: 'POPUP', documentId: 'popup', documentUrl: url }] } });
    try {
      expect(await isActionPopup({ id: 'extension', documentId: 'popup', url })).toBe(true);
      expect(await isActionPopup({ id: 'extension', url })).toBe(true);
      expect(await isActionPopup({ id: 'extension', documentId: 'popup', url, tab: { id: 1 } })).toBe(false);
      expect(await isActionPopup({ id: 'extension', documentId: 'another', url })).toBe(false);
      expect(validCaptureRequest({ kind: 'known.capture.get', captureId: 'other-account', accountId: 'other' })).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
