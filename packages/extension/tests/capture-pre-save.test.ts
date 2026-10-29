import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAutomation, CaptureAutomation, CaptureSource } from '../src/capture/contracts.js';
import { installCaptureContentBindings } from '../src/capture/content-binding.js';

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
  browser: vi.fn(),
  recover: vi.fn(async (_tasks: readonly unknown[]) => 0),
  workRun: vi.fn(async () => { throw new Error('not run here'); }),
  unavailable: new Set<string>(),
  noDefault: false,
}));

vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope, assertCaptureScope: async () => undefined,
  assertCaptureOwner: async () => undefined, captureExistence: vi.fn(), createNativeCapture: vi.fn(), recoverNativeCapture: vi.fn(),
  nativeCaptureLocation: async (nativeId: string) => ({ nativeId, nodeId: null, collectionId: null, collectionTitle: null,
    path: ['Inbox'], writable: true, url: 'https://www.bilibili.com/video/av1' }) }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async (_scope: unknown, id?: string) => {
  if (!id && f.noDefault) throw new Error('capture_target_required');
  const nativeId = id ?? '21';
  if (f.unavailable.has(nativeId)) throw new Error('capture_target_unavailable');
  return { nativeId, path: ['Bookmarks bar', nativeId === '10' ? 'Academic' : 'Inbox'], inRange: nativeId === '10', collectionId: 'c_personal', collectionTitle: null };
} }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true,
  workCoordinator: { run: f.workRun } }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ captureMode: f.mode, bookmarkInsertPosition: 'bottom' }) }));
vi.mock('../src/capture/control.js', () => ({ readCaptureControl: async () => ({ paused: false, generation: 0, consent: f.consent }) }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationEnabled: async () => f.local }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/capture-local.js', () => ({ captureTagMode: async () => f.tagMode }));
// The account's rules, then this browser's (sw/automation.ts rulesDecision; its pause is tested with the worker).
vi.mock('../src/sw/automation.js', () => ({ recordPreSaveReceipt: vi.fn(), recoverPreSaveReceipts: f.recover,
  rulesDecision: async (scope: unknown, page: unknown) => await f.decide(scope, page).catch(() => null) ?? await f.browser(page).catch(() => null) }));
vi.mock('../src/sw/capture-classification.js', () => ({ classifySavedCapture: vi.fn(), undoSavedCapture: vi.fn() }));
vi.mock('../src/sw/capture-annotation.js', () => ({ persistCaptureAnnotation: vi.fn() }));
vi.mock('../src/sw/bookmark-pins.js', () => ({ pinNode: vi.fn() }));
vi.mock('../src/sw/capture-sync.js', () => ({ reconcileCaptureSync: vi.fn() }));
vi.mock('../src/sw/capture-result-recovery.js', () => ({ inspectCaptureDecision: vi.fn(), applyCaptureSuggestion: vi.fn() }));
vi.mock('../src/sw/capture-remove.js', () => ({ cancelRemovedCapture: vi.fn() }));
vi.mock('../src/classification-product-client.js', () => ({ createClassificationProductClient: vi.fn() }));
// Planned source saves have their own runtime tests; these cases exercise ordinary pre-save rules.
vi.mock('../src/site-adapters/planned-runtime.js', () => ({ executePlannedSave: async () => { throw new Error('unexpected planned save'); } }));

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
  f.scope = { ...f.scope, accountId: 'owner', collectionId: 'c_personal' }; f.mode = 'manual'; f.local = false; f.tagMode = 'suggest'; f.consent = null; f.unavailable.clear(); f.noDefault = false;
  f.decide.mockReset().mockResolvedValue({ automation: placed, targetNativeId: '10' });
  f.browser.mockReset().mockResolvedValue(null);
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

describe('browser rules, below the account’s (design 01 §7.5)', () => {
  const byBrowser: BrowserAutomation = { source: 'browser', outcome: 'placed', rule: { id: 'b-1', name: 'Papers from arXiv' }, ruleIds: ['b-1'],
    folderTitle: 'Papers', fromNativeId: '21' };
  beforeEach(() => { f.browser.mockResolvedValue({ automation: byBrowser, targetNativeId: '30' }); });

  it('are not asked when an account rule decided, whatever it decided', async () => {
    await start('manual-popup');
    f.decide.mockResolvedValue({ automation: { ...placed, outcome: 'expired', satisfies: [] }, targetNativeId: null });
    expect(await start('manual-popup')).toMatchObject({ targetNativeId: '21', automation: { outcome: 'expired' } });
    expect(f.browser).not.toHaveBeenCalled();
  });

  it('file a page no account rule matched, signed out too, with the same facts', async () => {
    f.decide.mockResolvedValue(null);
    const task = await start('context-page');
    expect(f.browser).toHaveBeenCalledWith({ url: task.url, title: 'A paper', parentNativeId: '21', explicit: false });
    expect(task).toMatchObject({ targetNativeId: '30', sync: 'local-only', automation: byBrowser });
    f.scope = { ...f.scope, accountId: null as unknown as string, collectionId: null as unknown as string };
    expect(await start('context-page')).toMatchObject({ targetNativeId: '30', automation: { source: 'browser', outcome: 'placed' } });
  });

  it('keep the save where it was going when their folder cannot take it', async () => {
    f.decide.mockResolvedValue(null); f.unavailable.add('30');
    expect(await start('manual-popup')).toMatchObject({ targetNativeId: '21',
      automation: { source: 'browser', outcome: 'blocked', reason: 'bindingUnavailable', rule: { name: 'Papers from arXiv' } } });
  });

  it('give a save with no folder of its own the one they file it in, and nothing else does (doc 17 RS-00)', async () => {
    f.decide.mockResolvedValue(null); f.noDefault = true;
    const task = await start('manual-popup');
    expect(f.browser).toHaveBeenCalledWith({ url: task.url, title: 'A paper', parentNativeId: '', explicit: false });
    expect(task).toMatchObject({ targetNativeId: '30', automation: { source: 'browser', outcome: 'placed' } });
    f.browser.mockResolvedValue(null);
    await expect(start('manual-popup')).rejects.toThrow('capture_target_required');
    f.browser.mockResolvedValue({ automation: byBrowser, targetNativeId: '30' }); f.unavailable.add('30');
    await expect(start('context-page')).rejects.toThrow('capture_target_required');
  });

  it('ask the user’s own AI for tags only after they placed a page', async () => {
    f.decide.mockResolvedValue(null); f.mode = 'automatic'; f.local = true;
    expect(await start('action-popup')).toMatchObject({ classification: 'waiting', automation: { source: 'browser' } });
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
    // A browser rule's placement has no receipt to recover.
    await saved({ source: 'browser', outcome: 'placed', rule: { id: 'b-1', name: 'Papers' }, ruleIds: ['b-1'], folderTitle: 'Papers', fromNativeId: '21' });
    f.recover.mockClear();
    await wakeCaptures();
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.recover.mock.calls[0]![0]).toEqual([expect.objectContaining({ captureId: fresh.captureId })]);
  });
});

it('an explicit extra copy preserves its chosen folder instead of reusing or moving the site-bound bookmark', async () => {
  f.decide.mockResolvedValue(null);
  const url = 'https://www.bilibili.com/video/av1';
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'existing', dateAdded: 10, parentId: '21', title: 'Video', url }] },
    tabs: { query: async () => [] }, runtime: { sendMessage: async () => undefined } });
  const prepare = vi.fn(async (input: { captureIntentId: string; title: string; url: string }) => ({
    bindingId: 'known-content', itemId: 'video:av:1', connectionId: null, mode: 'reuse' as const,
    captureIntentId: input.captureIntentId, nativeId: 'existing', dateAdded: 10, title: input.title, url: input.url, parentId: '21',
  }));
  installCaptureContentBindings({ prepare, assert: async () => {}, acknowledge: async () => {} });
  try {
    const normal = await startCapture({ commandId: crypto.randomUUID(), source: 'manual-popup', title: 'Video', url });
    expect(normal).toMatchObject({ disposition: 'existing', nativeId: 'existing', targetNativeId: '21' });
    const extra = await startCapture({ commandId: crypto.randomUUID(), source: 'manual-popup', title: 'Another copy', url,
      saveAnother: true, folderChoice: 'explicit', parentNativeId: '20' });
    expect(extra).toMatchObject({ disposition: 'new', save: 'unsubmitted', nativeId: null, title: 'Another copy', targetNativeId: '20', saveAnother: true });
    expect(extra.contentIntent).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
  } finally { installCaptureContentBindings({ prepare: async () => null, assert: async () => {}, acknowledge: async () => {} }); }
});


it('wakes an existing capture with an unfinished explicit move', async () => {
  f.scope = { ...f.scope, accountId: 'move-wake' }; f.decide.mockResolvedValue(null);
  const url = 'https://www.bilibili.com/video/av1';
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'existing', dateAdded: 10, parentId: '21', title: 'Video', url }] },
    tabs: { query: async () => [] }, runtime: { sendMessage: async () => undefined } });
  installCaptureContentBindings({ prepare: async input => ({ bindingId: 'known-content', itemId: 'video:av:1', connectionId: null, mode: 'reuse',
    captureIntentId: input.captureIntentId, nativeId: 'existing', dateAdded: 10, title: input.title, url: input.url, parentId: '21' }), assert: async () => {}, acknowledge: async () => {} });
  try {
    const task = await startCapture({ commandId: crypto.randomUUID(), source: 'manual-popup', title: 'Video', url });
    const current = (await captureStore.get(f.scope, task.captureId))!;
    await captureStore.update({ ...current, contentIntent: { ...current.contentIntent!, desiredParentId: '20' }, revision: current.revision + 1 }, current.revision);
    f.workRun.mockClear();
    await wakeCaptures();
    expect(f.workRun).toHaveBeenCalledOnce();
  } finally { installCaptureContentBindings({ prepare: async () => null, assert: async () => {}, acknowledge: async () => {} }); }
});
