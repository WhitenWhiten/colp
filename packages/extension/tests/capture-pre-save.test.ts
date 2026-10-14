import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureAutomation, CaptureSource } from '../src/capture/contracts.js';

/**
 * Every extension-owned save asks the rules before the native create (AC-01):
 * the popup, the shortcut (the popup), the context menu and Save tabs all start
 * here, and a placement becomes the create's parent, never a later move.
 */
const f = vi.hoisted(() => ({
  scope: { serverOrigin: 'https://known.test', accountId: 'owner' as string, authorityGeneration: 1, collectionId: 'c_personal' },
  mode: 'manual' as 'manual' | 'automatic',
  local: false,
  tagMode: 'suggest' as 'off' | 'suggest' | 'add',
  consent: null as null | { readonly expiresAt: number },
  decide: vi.fn(),
  recover: vi.fn(async (_tasks: readonly unknown[]) => 0),
  unavailable: new Set<string>(),
}));

vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope, assertCaptureScope: async () => undefined,
  assertCaptureOwner: async () => undefined, captureExistence: vi.fn(), createNativeCapture: vi.fn(), recoverNativeCapture: vi.fn() }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async (_scope: unknown, id?: string) => {
  const nativeId = id ?? '21';
  if (f.unavailable.has(nativeId)) throw new Error('capture_target_unavailable');
  return { nativeId, path: ['Bookmarks bar', nativeId === '10' ? 'Academic' : 'Inbox'], inRange: nativeId === '10', collectionId: 'c_personal', collectionTitle: null };
} }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true,
  workCoordinator: { run: async () => { throw new Error('not run here'); } } }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ captureMode: f.mode, bookmarkInsertPosition: 'bottom' }) }));
vi.mock('../src/capture/control.js', () => ({ readCaptureControl: async () => ({ paused: false, generation: 0, consent: f.consent }) }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationEnabled: async () => f.local }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture-local.js', () => ({ captureTagMode: async () => f.tagMode }));
vi.mock('../src/sw/automation.js', () => ({ preSaveDecision: f.decide, recordPreSaveReceipt: vi.fn(), recoverPreSaveReceipts: f.recover }));
vi.mock('../src/sw/capture-classification.js', () => ({ classifySavedCapture: vi.fn(), undoSavedCapture: vi.fn() }));
vi.mock('../src/sw/capture-annotation.js', () => ({ persistCaptureAnnotation: vi.fn() }));
vi.mock('../src/sw/bookmark-pins.js', () => ({ pinNode: vi.fn() }));
vi.mock('../src/sw/capture-sync.js', () => ({ reconcileCaptureSync: vi.fn() }));
vi.mock('../src/sw/capture-result-recovery.js', () => ({ inspectCaptureDecision: vi.fn(), applyCaptureSuggestion: vi.fn() }));
vi.mock('../src/sw/capture-remove.js', () => ({ cancelRemovedCapture: vi.fn() }));
vi.mock('../src/classification-product-client.js', () => ({ createClassificationProductClient: vi.fn() }));

import { captureStore, startCapture, wakeCaptures } from '../src/sw/capture.js';

const placed: CaptureAutomation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1,
  satisfies: ['classify.root'], rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'digest' },
  destination: { serverUuid: 'server', collectionId: 'c_personal', nodeId: 'academic' }, folderTitle: 'Academic', fromNativeId: '21',
  collectionId: 'c_personal', replicaId: 'replica', generation: 1 };
let command = 0;
const start = (source: CaptureSource, extra: { readonly folderChoice?: 'explicit' | 'default'; readonly parentNativeId?: string } = {}) =>
  // One active save per URL: each start saves another paper.
  startCapture({ commandId: `00000000-0000-4000-8000-${String(++command).padStart(12, '0')}`, source,
    url: `https://arxiv.org/abs/2410.${String(command).padStart(5, '0')}`, title: 'A paper', ...extra });

beforeEach(() => {
  f.scope = { ...f.scope, accountId: 'owner' }; f.mode = 'manual'; f.local = false; f.tagMode = 'suggest'; f.consent = null; f.unavailable.clear();
  f.decide.mockReset().mockResolvedValue({ automation: placed, targetNativeId: '10' });
  vi.stubGlobal('chrome', { tabs: { get: async () => null, query: async () => [] }, runtime: { sendMessage: async () => undefined } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('pre-save rules on every extension save path', () => {
  it.each([['action-popup', 'automatic'], ['context-page', 'automatic'], ['context-link', 'automatic'], ['manual-popup', 'manual'], ['batch', 'manual']] as const)(
    '%s creates the bookmark in the rule folder', async (source, mode) => {
      f.mode = mode;
      const task = await start(source);
      expect(f.decide).toHaveBeenCalledWith(f.scope, { url: task.url, title: 'A paper', parentNativeId: '21', explicit: false });
      expect(task).toMatchObject({ targetNativeId: '10', sync: 'pending', automation: placed, classification: 'none' });
    });

  it('tells the rules when the user chose the folder', async () => {
    f.decide.mockResolvedValue({ automation: { ...placed, outcome: 'kept', satisfies: [] }, targetNativeId: null });
    const task = await start('manual-popup', { folderChoice: 'explicit', parentNativeId: '20' });
    expect(f.decide.mock.calls[0]![1]).toMatchObject({ parentNativeId: '20', explicit: true });
    expect(task).toMatchObject({ targetNativeId: '20', automation: { outcome: 'kept' } });
  });

  it('saves where it was going when the rule folder cannot take the save', async () => {
    f.unavailable.add('10');
    const task = await start('context-page');
    expect(task.targetNativeId).toBe('21');
    expect(task.automation).toMatchObject({ outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] });
  });

  it('leaves a save alone when no rule applies or the rules cannot be read', async () => {
    f.decide.mockResolvedValue(null);
    expect(await start('manual-popup')).not.toHaveProperty('automation');
    f.decide.mockRejectedValue(new Error('storage'));
    expect(await start('manual-popup')).toMatchObject({ targetNativeId: '21' });
  });
});

describe('which classifier an automatic save may use after a rule', () => {
  beforeEach(() => { f.mode = 'automatic'; });

  it('asks the user’s own AI for tags only, and only while tags are on', async () => {
    f.local = true;
    expect(await start('action-popup')).toMatchObject({ classification: 'waiting', local: { state: 'waiting' }, automation: { outcome: 'placed' } });
    f.tagMode = 'off';
    const off = await start('action-popup');
    expect(off.classification).toBe('none');
    expect(off).not.toHaveProperty('local');
  });

  it('never runs a Know-N folder suggestion for a rule hit, even a blocked one', async () => {
    f.consent = { expiresAt: Date.now() + 60_000 };
    expect((await start('context-page')).classification).toBe('none');
    f.decide.mockResolvedValue({ automation: { ...placed, outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] }, targetNativeId: null });
    expect((await start('context-page')).classification).toBe('none');
    f.decide.mockResolvedValue(null);
    // No rule: the save is classified as before (the default folder 21 is outside the synced range here, so local only).
    f.local = true;
    expect((await start('context-page')).classification).toBe('waiting');
  });
});

describe('a placed save’s receipt after a worker stop', () => {
  it('is handed to receipt recovery on wake, while a save that was not placed or is a week old is not', async () => {
    const saved = async (automation: CaptureAutomation, savedAt = Date.now()) => {
      const task = await start('manual-popup');
      const current = (await captureStore.get(f.scope, task.captureId))!;
      const next = { ...current, save: 'local-saved' as const, nativeId: `n-${current.captureId}`, savedAt, automation, revision: current.revision + 1 };
      await captureStore.update(next, current.revision);
      return next;
    };
    // Its own account: the earlier saves here are not this wake's business.
    f.scope = { ...f.scope, accountId: 'woken' };
    const fresh = await saved(placed);
    await saved({ ...placed, outcome: 'kept', satisfies: [] });
    await saved(placed, Date.now() - 8 * 86_400_000);
    f.recover.mockClear();
    await wakeCaptures();
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.recover.mock.calls[0]![0]).toEqual([expect.objectContaining({ captureId: fresh.captureId })]);
  });
});
