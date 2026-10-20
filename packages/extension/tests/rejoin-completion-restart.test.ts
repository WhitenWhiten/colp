import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { resolveRejoinDecision } from '../src/scope-rejoin-decisions.js';
import { detachScopeMount } from '../src/scope-commands.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test('Keep cloud resumes mount activation after its completed decision commits before worker termination', async () => {
  const f = await deletionFixture();
  try {
    await f.compare();
    const [decision] = await f.list();
    const store = f.getStore();
    await expect(resolveRejoinDecision({ ...f.input(), store: { ...store,
      completeRejoinDecision: async (...args) => {
        await store.completeRejoinDecision(...args);
        throw new Error('worker_terminated_after_decision_completion');
      } } }, { kind: 'known.sync.rejoinDecisions.resolve', commandId: decision!.commandId,
      token: decision!.token, choice: 'keep_remote', userGesture: true }))
      .rejects.toThrow('worker_terminated_after_decision_completion');
    expect((await store.getScopeCommandPlan(scope, decision!.commandId))?.phase).toBe('active');
    expect((await store.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
    const nativeBefore = f.api.all();
    expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(3);
    f.reopen();
    await f.refresh();
    expect((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
    await f.refresh();
    expect(f.api.all()).toEqual(nativeBefore);
    expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(3);
    expect(await f.getStore().listQueue(scope)).toEqual([]);
  } finally { f.getStore().close(); }
});

test('activation aborts both the mount and journal when persistence fails after the mount write', async () => {
  const f = await deletionFixture();
  const put = IDBObjectStore.prototype.put;
  let injected = false;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (!injected && this.name === 'scope_command_plans' && value.commandId === 'rejoin:mount-bar' && value.phase === 'active') {
      injected = true; throw new Error('activation_transaction_failed');
    }
    return put.call(this, value, key);
  });
  try {
    await f.compare();
    await expect(f.resolve('keep_remote')).rejects.toThrow('activation_transaction_failed');
    expect(injected).toBe(true);
    expect((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
    expect((await f.getStore().getScopeCommandPlan(scope, 'rejoin:mount-bar'))?.phase).toBe('applying');
    spy.mockRestore(); f.reopen(); await f.refresh();
    expect((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
    expect((await f.getStore().getScopeCommandPlan(scope, 'rejoin:mount-bar'))?.phase).toBe('active');
    expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(3);
  } finally { spy.mockRestore(); f.getStore().close(); }
});

test.each(['private', 'scope_version', 'pause', 'mapping', 'permission'] as const)(
  'activation checks the current %s authority after comparison', async changed => {
    const f = await deletionFixture();
    try {
      await f.compare();
      const [decision] = await f.list(), store = f.getStore();
      await expect(resolveRejoinDecision({ ...f.input(), store: { ...store,
        completeRejoinMount: async (...args) => {
          if (changed === 'mapping') await store.deleteMapping(scope, 'native-root');
          else if (changed === 'private') await store.configureBrowserRoots(scope, { status: 'ready',
            discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
            selectedNativeIds: [], privateNativeIds: ['native-root'] });
          else if (changed === 'scope_version') await store.bumpBoundaryVersion(scope);
          else if (changed === 'permission') await store.setBrowserRootStatus(scope, 'permission_required');
          else {
            const mount = (await store.getMountBinding(scope, 'mount-bar'))!;
            await store.putMountPauseBaseline(scope, mount.mountId, { ...mount.pauseBaseline!, lastAppliedCursor: 'later-pause' });
          }
          return store.completeRejoinMount(...args);
        } } }, { kind: 'known.sync.rejoinDecisions.resolve', commandId: decision!.commandId,
        token: decision!.token, choice: 'keep_remote', userGesture: true })).rejects.toThrow('rejoin_boundary_changed');
      const nativeBefore = f.api.all();
      expect((await store.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
      f.reopen(); await f.refresh();
      expect((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
      expect(f.api.all()).toEqual(nativeBefore);
      expect(await f.getStore().listQueue(scope)).toEqual([]);
    } finally { f.getStore().close(); }
  });

test('a completed historical decision cannot undo a later explicit pause, even at the same server cursor', async () => {
  const f = await deletionFixture();
  try {
    await f.compare(); await f.resolve('keep_remote');
    const completed = (await f.getStore().getScopeCommandPlan(scope, 'rejoin:mount-bar'))!;
    const mount = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
    expect(completed.phase).toBe('active');
    await detachScopeMount(f.getStore(), scope, mount.mountId);
    expect((await f.getStore().getMountBinding(scope, mount.mountId))?.pauseBaseline).toEqual(mount.pauseBaseline);
    const nativeBefore = f.api.all(); f.reopen(); await f.refresh();
    expect((await f.getStore().getMountBinding(scope, mount.mountId))?.status).toBe('detached');
    expect(f.api.all()).toEqual(nativeBefore);
    expect((await f.getStore().getScopeCommandPlan(scope, completed.commandId))?.phase).toBe('active');
  } finally { f.getStore().close(); }
});
