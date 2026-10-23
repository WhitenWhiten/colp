import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { LocalImportPlan } from '../src/local-import/contracts.js';

const state = vi.hoisted(() => ({ plan: undefined as LocalImportPlan | undefined,
  run: vi.fn(), alarm: undefined as { name: string } | undefined,
  create: vi.fn(), clear: vi.fn() }));
vi.mock('../src/local-import/store.js', () => ({ createLocalImportStore: () => ({ plan: async () => state.plan }) }));
vi.mock('../src/local-import/coordinator.js', () => ({ createLocalImporter: () => ({ run: state.run }) }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ assertPersonalNativeAllowed: vi.fn(), personalBookmarks: { create: vi.fn() } }));
vi.mock('../src/local-backup/restore.js', () => ({ restoreBackupMetadata: vi.fn() }));
vi.mock('../src/local-import/annotations.js', () => ({ restoreItemAnnotations: vi.fn() }));
import { LOCAL_IMPORT_ALARM, wakeLocalImports } from '../src/sw/local-import.js';

const plan = (kind: LocalImportPlan['state']): LocalImportPlan => ({ commandId: 'command', digest: 'digest',
  targetNativeId: '1', folderTitle: 'Import', state: kind, next: 0, total: 1,
  reason: null });
beforeEach(() => {
  vi.clearAllMocks(); state.plan = undefined; state.alarm = undefined;
  state.create.mockImplementation((name: string) => { state.alarm = { name }; });
  state.clear.mockImplementation(async () => { state.alarm = undefined; return true; });
  vi.stubGlobal('chrome', { alarms: { get: async () => state.alarm, create: state.create, clear: state.clear } });
});
afterEach(() => vi.unstubAllGlobals());

test.each(['completed', 'cancelled', 'attention'] as const)('a %s import clears its periodic recovery wake', async kind => {
  state.plan = plan(kind); state.alarm = { name: LOCAL_IMPORT_ALARM };
  await wakeLocalImports();
  expect(state.clear).toHaveBeenCalledWith(LOCAL_IMPORT_ALARM);
  expect(state.alarm).toBeUndefined(); expect(state.run).not.toHaveBeenCalled();
});
test('an obsolete alarm with no retained plan clears itself', async () => {
  state.alarm = { name: LOCAL_IMPORT_ALARM }; await wakeLocalImports(); expect(state.alarm).toBeUndefined();
});
test('a restarted running import keeps a retry wake through failure and clears it after completion', async () => {
  state.plan = plan('running'); state.run.mockRejectedValueOnce(new Error('temporary storage failure'));
  await expect(wakeLocalImports()).rejects.toThrow('temporary storage failure');
  expect(state.alarm).toEqual({ name: LOCAL_IMPORT_ALARM });
  state.run.mockImplementationOnce(async () => { state.plan = plan('completed'); return state.plan; });
  await wakeLocalImports(); expect(state.alarm).toBeUndefined(); expect(state.create).toHaveBeenCalledTimes(1);
});
