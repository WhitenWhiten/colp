import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBundleStore, chromeLocalArea } from '../src/automation/bundle-store.js';
import { createReceiptStore } from '../src/automation/receipt-sync.js';
import type { CaptureAutomation, CaptureTask } from '../src/capture/contracts.js';
import { COLLECTION_ID, NOW, compiledRule, ruleBundle } from './automation-fixture.js';
import { task as base } from './fixtures/capture.js';

/** The worker side of pre-save: the decision comes from this account's installed bundle; a placement is receipted once. */
const f = vi.hoisted(() => ({
  sync: { environment: 'production', serverId: 'https://colp.example', serverOrigin: 'https://colp.example', accountId: 'owner',
    browserProfileId: 'profile', collectionId: 'c_personal', replicaId: 'replica-1', generation: 2 },
  mappings: { academic: '10', inbox: '21' } as Record<string, string>,
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => null, loadBinding: async () => null },
  syncState: {
    getMappingByColpId: async (_scope: unknown, colpId: string) => f.mappings[colpId] ? { nativeId: f.mappings[colpId], nodeKind: 'folder' } : null,
    getMappingByNativeId: async (_scope: unknown, nativeId: string) => {
      const colpId = Object.keys(f.mappings).find((key) => f.mappings[key] === nativeId);
      return colpId ? { colpId, nodeKind: 'folder' } : null;
    },
  },
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.sync, loadConfig: async () => ({ serverOrigin: 'https://colp.example' }),
  pushSessionAuthority: async () => { throw new Error('offline'); } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => scope }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));

import { handleAutomationRequest, preSaveDecision, recordPreSaveReceipt } from '../src/sw/automation.js';

const scope = { serverOrigin: 'https://colp.example', accountId: 'owner', authorityGeneration: 1, collectionId: COLLECTION_ID };
const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const page = { url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId: '21', explicit: false };
const nodes: Record<string, { id: string; title: string; parentId: string }> = {
  10: { id: '10', title: 'Academic', parentId: '1' }, 21: { id: '21', title: 'Inbox', parentId: '1' } };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() },
    bookmarks: { get: async (id: string) => nodes[id] ? [nodes[id]] : [] } });
  await createBundleStore(chromeLocalArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-3', settingsRevision: 3 }), NOW);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('pre-save in the worker', () => {
  it('decides from this account’s bundle and the current Sync mapping', async () => {
    expect(await preSaveDecision(scope, page)).toMatchObject({ targetNativeId: '10',
      automation: { outcome: 'placed', bundleRevision: 'b-3', replicaId: 'replica-1', generation: 2, folderTitle: 'Academic' } });
    // Another account, a signed-out save or another collection never sees these rules.
    expect(await preSaveDecision({ ...scope, accountId: 'someone-else' }, page)).toBeNull();
    expect(await preSaveDecision({ ...scope, accountId: null, collectionId: null }, page)).toBeNull();
    expect(await preSaveDecision({ ...scope, collectionId: 'c_other' }, page)).toBeNull();
  });

  it('answers the popup’s preview without placing anything', async () => {
    expect(await handleAutomationRequest({ kind: 'known.automation.match', ...page })).toEqual({ ok: true,
      match: { outcome: 'placed', ruleName: 'Place research papers in Academic', ruleCount: 1, folderNativeId: '10', folderTitle: 'Academic' } });
    expect(await createReceiptStore(chromeLocalArea()).list()).toEqual([]);
  });

  it('receipts a placed save once, under the capture id, with the native observation kept local', async () => {
    const automation = (await preSaveDecision(scope, page))!.automation;
    const saved: CaptureTask = { ...base, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f00', scope, save: 'local-saved', disposition: 'new',
      nativeId: '55', targetNativeId: '10', title: 'A paper', url: page.url, savedAt: NOW, automation };
    await recordPreSaveReceipt(saved);
    const receipts = createReceiptStore(chromeLocalArea());
    expect(await receipts.list()).toEqual([expect.objectContaining({
      localReceiptId: saved.captureId, ownerKey: JSON.stringify(['https://colp.example', 'owner']), collectionId: COLLECTION_ID,
      replicaId: 'replica-1', generation: 2, path: 'preSave', state: 'local', satisfies: ['classify.root'],
      rule: expect.objectContaining({ id: 'rule-arxiv', bundleRevision: 'b-3' }), destinationTitle: 'Academic',
      native: { nativeId: '55', destinationNativeId: '10' }, page: { title: 'A paper', url: page.url } })]);
    // A repeated acknowledgement never resets a receipt already in progress.
    await receipts.update(saved.captureId, (receipt) => ({ ...receipt, state: 'accepted' }), NOW);
    await recordPreSaveReceipt(saved);
    expect(await receipts.list()).toEqual([expect.objectContaining({ state: 'accepted' })]);
    // Only a placement is receipted.
    const kept: CaptureAutomation = { ...automation, outcome: 'kept', satisfies: [] };
    await recordPreSaveReceipt({ ...saved, captureId: '1b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f00', automation: kept });
    await recordPreSaveReceipt({ ...saved, captureId: '2b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f00', save: 'failed' });
    expect(await receipts.list()).toHaveLength(1);
  });
});
