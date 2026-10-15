import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBundleStore } from '../src/automation/bundle-store.js';
import { createReceiptStore } from '../src/automation/receipt-sync.js';
import { validBrowserRuleCommand } from '../src/automation/messages.js';
import type { BrowserRuleDraft } from '../src/automation/browser-rules.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import { COLLECTION_ID, NOW, compiledRule, ruleBundle } from './automation-fixture.js';
import { task as base } from './fixtures/capture.js';

/** Browser rules in the worker (AW-67): asked after the account's rules, written from Options, logged without a receipt. */
const f = vi.hoisted(() => ({
  scope: { serverOrigin: 'https://colp.example', accountId: 'owner' as string | null, authorityGeneration: 1, collectionId: 'c_personal' as string | null },
  sync: { environment: 'production', serverId: 'https://colp.example', serverOrigin: 'https://colp.example', accountId: 'owner',
    browserProfileId: 'profile', collectionId: 'c_personal', replicaId: 'replica-1', generation: 2 },
  mappings: { academic: '10', inbox: '21' } as Record<string, string>,
  credential: null as null | { serverOrigin: string; subject: string },
  recent: [] as { id: string; title: string; url?: string }[],
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => f.credential, loadBinding: async () => null },
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
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));

import { automationArea, automationStateView, handleAutomationRequest, recordPreSaveReceipt } from '../src/sw/automation.js';
import { browserRuleStore, handleBrowserRuleCommand } from '../src/sw/automation-browser.js';

const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const paper = { url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId: '21' };
const nodes: Record<string, { id: string; title: string; parentId: string }> = {
  10: { id: '10', title: 'Academic', parentId: '1' }, 21: { id: '21', title: 'Inbox', parentId: '1' }, 30: { id: '30', title: 'Papers', parentId: '2' } };
const draft = (over: Partial<BrowserRuleDraft> = {}): BrowserRuleDraft =>
  ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], folderNativeId: '30', ...over });
const match = (request = paper) => handleAutomationRequest({ kind: 'known.automation.match', ...request });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, bookmarks: { get: async (id: string) => nodes[id] ? [nodes[id]] : [],
    getRecent: async (count: number) => f.recent.slice(0, count) } });
  f.credential = null; f.recent = [];
  f.scope = { serverOrigin: 'https://colp.example', accountId: 'owner', authorityGeneration: 1, collectionId: COLLECTION_ID };
  expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft() })).toMatchObject({ ok: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the popup’s preview', () => {
  it('shows a browser rule’s folder with no account at all', async () => {
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    expect(await match()).toEqual({ ok: true, match: { outcome: 'placed', ruleName: 'Papers from arXiv', ruleCount: 1, folderNativeId: '30', folderTitle: 'Papers' } });
  });

  it('shows the account’s rule when one matches, and this browser’s only for pages it does not', async () => {
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-3', settingsRevision: 3 }), NOW);
    expect(await match()).toMatchObject({ match: { ruleName: 'Place research papers in Academic', folderNativeId: '10' } });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ name: 'GitHub', conditions: [{ kind: 'siteEndsWith', value: 'github.com' }] }) });
    expect(await match({ ...paper, url: 'https://github.com/know-n/colp' })).toMatchObject({ match: { ruleName: 'GitHub', folderNativeId: '30' } });
  });

  it('falls back to this browser’s rules while the account’s are paused', async () => {
    await createBundleStore(automationArea(), owner).install(ruleBundle([], { paused: true, settingsRevision: 4 }), NOW);
    expect(await match()).toMatchObject({ match: { ruleName: 'Papers from arXiv', folderNativeId: '30' } });
  });
});

describe('a placed save', () => {
  it('is logged once for Options and never receipted', async () => {
    const [rule] = await browserRuleStore().list();
    const saved: CaptureTask = { ...base, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f01', scope: { ...f.scope, accountId: null, collectionId: null },
      save: 'local-saved', disposition: 'new', nativeId: '55', targetNativeId: '30', title: 'A paper', url: paper.url, savedAt: NOW,
      automation: { source: 'browser', outcome: 'placed', rule: { id: rule!.id, name: 'Papers from arXiv' }, ruleIds: [rule!.id], folderTitle: 'Papers', fromNativeId: '21' } };
    await recordPreSaveReceipt(saved);
    await recordPreSaveReceipt(saved);
    expect(await browserRuleStore().placements()).toEqual([{ id: saved.captureId, ruleId: rule!.id, ruleName: 'Papers from arXiv', folder: 'Papers',
      title: 'A paper', url: paper.url, at: NOW }]);
    expect(await createReceiptStore(automationArea()).list()).toEqual([]);
    await recordPreSaveReceipt({ ...saved, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f02', automation: { ...saved.automation!, outcome: 'kept' } as CaptureTask['automation'] });
    expect(await browserRuleStore().placements()).toHaveLength(1);
  });
});

describe('Options’ commands', () => {
  it('save, switch off and remove a rule, and explain a draft it cannot keep', async () => {
    const [rule] = await browserRuleStore().list();
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: rule!.id, enabled: false })).toMatchObject({ ok: true, rule: { enabled: false } });
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    expect(await match()).toEqual({ ok: true, match: null });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ conditions: [{ kind: 'siteIs', value: 'not a host' }] }) }))
      .toEqual({ ok: false, error: 'invalid', problems: [{ field: 'condition', index: 0, code: 'invalidHost' }] });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.remove', id: rule!.id })).toEqual({ ok: true, rule: null });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.remove', id: rule!.id })).toEqual({ ok: false, error: 'notFound' });
  });

  it('are accepted only in their exact shape', () => {
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft() })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', id: 'b-1', draft: draft(), enabled: false })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: { ...draft(), extra: 1 } })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ conditions: [{ kind: 'hasTag' as never, value: 'x' }] }) })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ folderNativeId: '../1' }) })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: 'b-1', enabled: 'yes' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.remove', id: 'b 1' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.review', id: 'b-1', accountRuleId: 'rule-arxiv', key: '4:1' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.review', id: 'b-1', accountRuleId: '', key: '4:1' })).toBe(false);
  });
});

describe('next to the account’s rules (AW-69)', () => {
  const papers = (url: string) => ({ id: url, title: 'A paper', url });
  beforeEach(async () => {
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    f.recent = [papers('https://arxiv.org/abs/1'), papers('https://arxiv.org/abs/2'), { id: 'folder', title: 'A folder' }, papers('https://example.org/')];
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule({ ruleRevision: '4' })], { revision: 'b-3', settingsRevision: 3 }), NOW);
  });
  const overlap = async () => (await automationStateView()).browserRules[0]!.account;

  it('names the account rule that files the same pages elsewhere, with how many bookmarks both match', async () => {
    expect(await overlap()).toEqual({ kind: 'conflict', pages: 2, reviewed: false, reviewKey: '4:1',
      rule: { id: 'rule-arxiv', name: 'Place research papers in Academic', folder: 'Academic',
        match: { combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }] } } });
  });

  it('remembers Keep both until the account rule changes', async () => {
    const [rule] = await browserRuleStore().list();
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.review', id: rule!.id, accountRuleId: 'rule-arxiv', key: '4:1' }))
      .toMatchObject({ ok: true, rule: { reviewed: [{ accountRuleId: 'rule-arxiv', key: '4:1' }] } });
    expect(await overlap()).toMatchObject({ reviewed: true });
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule({ ruleRevision: '5' })], { revision: 'b-4', settingsRevision: 4 }), NOW);
    expect(await overlap()).toMatchObject({ reviewed: false, reviewKey: '5:1' });
  });

  it('is a duplicate when it files the same pages into the same folder, and nothing once switched off or signed out', async () => {
    const [rule] = await browserRuleStore().list();
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10' }) });
    expect(await overlap()).toMatchObject({ kind: 'duplicate', pages: 2 });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: rule!.id, enabled: false });
    expect(await overlap()).toBeNull();
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: rule!.id, enabled: true });
    f.credential = null;
    expect(await overlap()).toBeNull();
  });

  it('has nothing to compare while the account’s rules are paused', async () => {
    await createBundleStore(automationArea(), owner).install(ruleBundle([], { paused: true, settingsRevision: 9 }), NOW);
    expect(await overlap()).toBeNull();
  });
});
