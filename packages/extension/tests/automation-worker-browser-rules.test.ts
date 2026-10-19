import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { captureControlKey } from '../src/capture/control.js';
import { MANUAL_CLASSIFICATION_AUTO } from '../src/manual-classification.js';
import { createBundleStore } from '../src/automation/bundle-store.js';
import { createReceiptStore } from '../src/automation/receipt-sync.js';
import { validBrowserRuleCommand } from '../src/automation/messages.js';
import type { RuleDraft } from '../src/automation/rule-conditions.js';
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
  authority: async (): Promise<unknown> => { throw new Error('offline'); },
  bundle: null as unknown,
  mode: 'manual' as 'manual' | 'automatic',
  ownAi: false,
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => f.credential, loadBinding: async () => null },
  syncState: {
    getMappingByColpId: async (_scope: unknown, colpId: string) => f.mappings[colpId] ? { nativeId: f.mappings[colpId], nodeKind: 'folder' } : null,
    getMappingByNativeId: async (_scope: unknown, nativeId: string) => {
      const colpId = Object.keys(f.mappings).find((key) => f.mappings[key] === nativeId);
      return colpId ? { colpId, nodeKind: 'folder', projection: { revision: '1' } } : null;
    },
  },
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.sync, loadConfig: async () => ({ serverOrigin: 'https://colp.example' }),
  pushSessionAuthority: () => f.authority() }));
vi.mock('../src/automation/device-client.js', () => ({ fetchRuleBundle: async () => ({ ok: true, body: f.bundle }),
  acknowledgeRuleBundle: async () => undefined, postIntakeReceipt: async () => ({ ok: false, problem: 'offline' }) }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ captureMode: f.mode }) }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationEnabled: async () => f.ownAi }));

import { accountLink, automationArea, automationStateView, handleAutomationRequest, recordPreSaveReceipt, refreshAutomation, rulesDecision } from '../src/sw/automation.js';
import { browserPlacementLog, browserRuleStore, handleBrowserRuleCommand, MOVING_STALE_MS } from '../src/sw/automation-browser.js';
import { individualRules } from '../src/automation/rule-list-store.js';
import { automationSaveLine } from '../src/save-status.js';

const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const paper = { url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId: '21' };
const nodes: Record<string, { id: string; title: string; parentId: string }> = {
  10: { id: '10', title: 'Academic', parentId: '1' }, 21: { id: '21', title: 'Inbox', parentId: '1' }, 30: { id: '30', title: 'Papers', parentId: '2' } };
const draft = ({ folderNativeId = '30', ...over }: Partial<RuleDraft> & { readonly folderNativeId?: string } = {}): RuleDraft =>
  ({ name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId }, ...over });
const match = (request = paper) => handleAutomationRequest({ kind: 'known.automation.match', ...request });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, bookmarks: { get: async (id: string) => nodes[id] ? [nodes[id]] : [],
    getRecent: async (count: number) => f.recent.slice(0, count) }, runtime: { sendMessage: vi.fn(async () => undefined) },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined } });
  vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
  f.credential = null; f.recent = []; f.bundle = null; f.mode = 'manual'; f.ownAi = false;
  f.authority = async () => { throw new Error('offline'); };
  f.scope = { serverOrigin: 'https://colp.example', accountId: 'owner', authorityGeneration: 1, collectionId: COLLECTION_ID };
  expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft() })).toMatchObject({ ok: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the popup’s preview', () => {
  it('shows a browser rule’s folder with no account at all', async () => {
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    expect(await match()).toEqual({ ok: true, match: { outcome: 'placed', ruleName: 'Papers from arXiv', sourceName: null, ruleCount: 1, folderNativeId: '30',
      folderTitle: 'Papers' } });
  });

  it('names a set’s rule with its set', async () => {
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    const made = await handleBrowserRuleCommand({ kind: 'known.automation.browser.set.save', name: 'Research' });
    if (!made.ok || !('set' in made) || !made.set) throw new Error('no set');
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', into: made.set.id, draft: draft({ name: 'arXiv', folderNativeId: '10' }) });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.reorder', order: [made.set.id, ...individualRules(await browserRuleStore().load()).map((rule) => rule.id)] });
    expect(await match()).toMatchObject({ match: { outcome: 'placed', ruleName: 'arXiv', sourceName: 'Research', folderNativeId: '10' } });
  });

  it('shows the account’s rule when one matches, and this browser’s only for pages it does not', async () => {
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-3', settingsRevision: 3 }), NOW);
    expect(await match()).toMatchObject({ match: { ruleName: 'Place research papers in Academic', folderNativeId: '10' } });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ name: 'GitHub', conditions: [{ kind: 'siteEndsWith', value: 'github.com' }] }) });
    expect(await match({ ...paper, url: 'https://github.com/know-n/colp' })).toMatchObject({ match: { ruleName: 'GitHub', folderNativeId: '30' } });
  });

  it('stand still while the account’s automations are paused, and file again once they resume', async () => {
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    const bundles = createBundleStore(automationArea(), owner);
    await bundles.install(ruleBundle([], { paused: true, settingsRevision: 4 }), NOW);
    expect(await match()).toEqual({ ok: true, match: null });
    expect(await rulesDecision(f.scope, { ...paper, explicit: false })).toBeNull();
    await bundles.install(ruleBundle([], { revision: 'b-5', settingsRevision: 5 }), NOW);
    expect(await match()).toMatchObject({ match: { ruleName: 'Papers from arXiv', folderNativeId: '30' } });
    expect(await rulesDecision(f.scope, { ...paper, explicit: false })).toMatchObject({ targetNativeId: '30', automation: { source: 'browser' } });
  });

  it('decide when the account has no rules here, and give way to the account’s rule once it has one', async () => {
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    expect(await rulesDecision(f.scope, { ...paper, explicit: false })).toMatchObject({ targetNativeId: '30', automation: { source: 'browser', outcome: 'placed' } });
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-3', settingsRevision: 3 }), NOW);
    const decision = await rulesDecision(f.scope, { ...paper, explicit: false });
    expect(decision).toMatchObject({ targetNativeId: '10', automation: { outcome: 'placed', rule: { name: 'Place research papers in Academic' } } });
    expect(decision!.automation).not.toHaveProperty('source', 'browser');
  });
});

describe('a save decided by this browser’s list', () => {
  const signedOut = () => ({ ...f.scope, accountId: null, collectionId: null });

  it('goes where the upper of two matching rules files it, and records which entry of which list decided', async () => {
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ name: 'Reading', conditions: [{ kind: 'titleContains', value: 'paper' }],
      folderNativeId: '10' }) });
    const [papers, reading] = individualRules(await browserRuleStore().load());
    const revision = (await browserRuleStore().load()).revision;
    expect(await rulesDecision(signedOut(), { ...paper, explicit: false })).toEqual({ targetNativeId: '30', automation: { source: 'browser', outcome: 'placed',
      rule: { id: papers!.id, name: 'Papers from arXiv' }, ruleIds: [papers!.id], folderTitle: 'Papers', fromNativeId: '21',
      entry: { listRevision: revision, kind: 'rule', ruleId: papers!.id } } });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.reorder', order: [reading!.id, papers!.id] });
    expect(await rulesDecision(signedOut(), { ...paper, explicit: false })).toMatchObject({ targetNativeId: '10',
      automation: { rule: { name: 'Reading' }, entry: { listRevision: revision + 1 } } });
  });

  it('keeps a page where it was saved by a rule that says so, and logs it with why', async () => {
    const [papers] = individualRules(await browserRuleStore().load());
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: { ...draft({ name: 'Listings', conditions: [{ kind: 'pathUnder', value: '/list' }] }),
      action: { kind: 'keepHere' } } });
    const keep = individualRules(await browserRuleStore().load())[1]!;
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.reorder', order: [keep.id, papers!.id] });
    const decision = await rulesDecision(signedOut(), { ...paper, url: 'https://arxiv.org/list/cs', explicit: false });
    expect(decision).toMatchObject({ targetNativeId: null, automation: { outcome: 'kept', reason: 'keepHere', rule: { name: 'Listings' } } });
    expect(automationSaveLine(decision!.automation)).toEqual({ attention: false, text: 'Kept where you saved it, by rule “Listings”.' });
    const saved: CaptureTask = { ...base, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f09', scope: signedOut(), save: 'local-saved', disposition: 'new',
      nativeId: '57', targetNativeId: '21', title: 'Listing', url: 'https://arxiv.org/list/cs', savedAt: NOW, automation: decision!.automation,
      localLocation: { collectionId: null, collectionTitle: null, nodeId: null, nativeId: '21', path: ['Bookmarks bar', 'Inbox'], writable: true, url: paper.url } };
    await recordPreSaveReceipt(saved);
    expect(await browserPlacementLog().placements()).toMatchObject([{ ruleName: 'Listings', folder: 'Inbox', kept: 'keepHere', entry: { kind: 'rule', ruleId: keep.id } }]);
  });
});

describe('the list Options shows', () => {
  it('keeps the order saves try, with each rule’s set and whether it takes part, and the order note until it is read', async () => {
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    const made = await handleBrowserRuleCommand({ kind: 'known.automation.browser.set.save', name: 'Research' });
    if (!made.ok || !('set' in made) || !made.set) throw new Error('no set');
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', into: made.set.id, draft: draft({ name: 'In the set' }) });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: made.set.id, enabled: false, entry: 'set' });
    const { browserList, browserRules } = await automationStateView();
    expect(browserList).toMatchObject({ enabled: true, orderNotice: null, entries: [{ kind: 'rule', rule: { name: 'Papers from arXiv', active: true, setId: null } },
      { kind: 'set', set: { name: 'Research', enabled: false, origin: { kind: 'custom' }, rules: [{ name: 'In the set', active: false, setId: made.set.id }] } }] });
    expect(browserRules.map((rule) => rule.name)).toEqual(['Papers from arXiv', 'In the set']);
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.duplicate', id: browserRules[0]!.id, entry: 'rule', name: 'Copy' }))
      .toMatchObject({ ok: true });
    expect((await automationStateView()).browserRules.map((rule) => rule.name)).toEqual(['Papers from arXiv', 'Copy', 'In the set']);
  });
});

describe('a placed save', () => {
  it('is logged once for Options and never receipted', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    const saved: CaptureTask = { ...base, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f01', scope: { ...f.scope, accountId: null, collectionId: null },
      save: 'local-saved', disposition: 'new', nativeId: '55', targetNativeId: '30', title: 'A paper', url: paper.url, savedAt: NOW,
      automation: { source: 'browser', outcome: 'placed', rule: { id: rule!.id, name: 'Papers from arXiv' }, ruleIds: [rule!.id], folderTitle: 'Papers', fromNativeId: '21' } };
    await recordPreSaveReceipt(saved);
    await recordPreSaveReceipt(saved);
    expect(await browserPlacementLog().placements()).toEqual([{ id: saved.captureId, ruleId: rule!.id, ruleName: 'Papers from arXiv', folder: 'Papers',
      title: 'A paper', url: paper.url, at: NOW }]);
    expect(await createReceiptStore(automationArea()).list()).toEqual([]);
    await recordPreSaveReceipt({ ...saved, captureId: '0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f02', automation: { ...saved.automation!, outcome: 'kept' } as CaptureTask['automation'] });
    expect(await browserPlacementLog().placements()).toHaveLength(1);
  });

  it('is logged with why when a rule matched but the page stayed where it was saved (U6)', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    const kept = (captureId: string, outcome: 'conflict' | 'blocked', at: number): CaptureTask => ({ ...base, captureId,
      scope: { ...f.scope, accountId: null, collectionId: null }, save: 'local-saved', disposition: 'new', nativeId: '56', targetNativeId: '21',
      title: 'A paper', url: paper.url, savedAt: at,
      localLocation: { collectionId: null, collectionTitle: null, nodeId: null, nativeId: '21', path: ['Bookmarks bar', 'Inbox'], writable: true, url: paper.url },
      automation: { source: 'browser', outcome, ...(outcome === 'blocked' ? { reason: 'bindingUnavailable' } : {}),
        rule: { id: rule!.id, name: 'Papers from arXiv' }, ruleIds: [rule!.id], fromNativeId: '21' } });
    await recordPreSaveReceipt(kept('0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f03', 'conflict', NOW));
    await recordPreSaveReceipt(kept('0b6f9a8e-3c1d-4f2a-9b7e-5d4c3b2a1f04', 'blocked', NOW + 1));
    expect((await browserPlacementLog().placements()).map(({ id, folder, kept: why }) => ({ id: id.slice(-2), folder, why })))
      .toEqual([{ id: '04', folder: 'Inbox', why: 'blocked' }, { id: '03', folder: 'Inbox', why: 'conflict' }]);
    expect((await automationStateView()).placements.map(({ state, kept: why }) => ({ state, why })))
      .toEqual([{ state: 'keptHere', why: 'blocked' }, { state: 'keptHere', why: 'conflict' }]);
  });
});

describe('how a page finds its folder past the rules (U3)', () => {
  it('reports the save mode and the AI in use here', async () => {
    expect((await automationStateView()).saving).toEqual({ mode: 'manual', ai: null, suggestInForm: false });
    await chrome.storage.local.set({ [MANUAL_CLASSIFICATION_AUTO]: true });
    f.mode = 'automatic'; f.ownAi = true;
    expect((await automationStateView()).saving).toEqual({ mode: 'automatic', ai: 'own', suggestInForm: true });
  });

  it('counts Know-N only with a live authorization for the collection saved into', async () => {
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' }; f.mode = 'automatic';
    const consent = { collectionId: COLLECTION_ID, priceVersion: 'p1', maxPoints: 5, periodPoints: 100, expiresAt: NOW + 3_600_000 };
    await chrome.storage.local.set({ [captureControlKey(f.scope)]: { paused: false, generation: 1, consent } });
    expect((await automationStateView()).saving.ai).toBe('knowN');
    await chrome.storage.local.set({ [captureControlKey(f.scope)]: { paused: false, generation: 1, consent: { ...consent, expiresAt: NOW - 1 } } });
    expect((await automationStateView()).saving.ai).toBeNull();
    await chrome.storage.local.set({ [captureControlKey(f.scope)]: { paused: false, generation: 1, consent: { ...consent, collectionId: 'c_other' } } });
    expect((await automationStateView()).saving.ai).toBeNull();
  });
});

describe('Options’ commands', () => {
  it('save, switch off and remove a rule, and explain a draft it cannot keep', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: rule!.id, enabled: false })).toMatchObject({ ok: true, rule: { enabled: false } });
    f.scope = { ...f.scope, accountId: null, collectionId: null };
    expect(await match()).toEqual({ ok: true, match: null });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft({ conditions: [{ kind: 'siteIs', value: 'not a host' }] }) }))
      .toEqual({ ok: false, error: 'invalid', problems: [{ field: 'condition', index: 0, code: 'invalidHost' }] });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.remove', id: rule!.id })).toEqual({ ok: true, rule: null });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.remove', id: rule!.id })).toEqual({ ok: false, error: 'notFound' });
  });

  it('fill in the web editor for a rule on all devices, from a synced folder only, and store nothing here', async () => {
    const forAccount = (folderNativeId: string) => handleBrowserRuleCommand({ kind: 'known.automation.browser.forAccount',
      draft: draft({ name: 'arxiv.org → Academic', folderNativeId }) }, accountLink);
    const before = individualRules(await browserRuleStore().load());
    expect(await forAccount('10')).toEqual({ ok: false, error: 'signedOut' });
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    const reply = await forAccount('10');
    expect(reply.ok && 'url' in reply ? Object.fromEntries(new URL(reply.url).searchParams) : reply).toEqual({ collectionId: 'c_personal',
      folderId: 'academic', name: 'arxiv.org → Academic', combinator: 'all', condition: 'siteIs:arxiv.org', from: 'browser' });
    // Papers is a folder here that Sync has not mapped.
    expect(await forAccount('30')).toEqual({ ok: false, error: 'notSynced' });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.forAccount',
      draft: draft({ conditions: [{ kind: 'siteIs', value: 'not a host' }], folderNativeId: '10' }) }, accountLink))
      .toEqual({ ok: false, error: 'invalid', problems: [{ field: 'condition', index: 0, code: 'invalidHost' }] });
    expect(individualRules(await browserRuleStore().load())).toEqual(before);
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
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.forAccount', draft: draft() })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.forAccount', draft: draft(), id: 'b-1' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.forAccount', draft: { ...draft(), extra: 1 } })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.save', draft: draft(), into: 's-1' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: 's-1', enabled: false, entry: 'set' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.enable', id: 's-1', enabled: false, entry: 'folder' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.reorder', order: ['b-1', 's-1'] })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.reorder', order: ['b 1'] })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.moveRule', ruleId: 'b-1', into: null, index: 0 })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.moveRule', ruleId: 'b-1', into: 's-1', index: -1 })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.moveRule', ruleId: 'b-1', into: 's-1', index: 1.5 })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.set.save', name: 'Reading' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.set.save', name: 'Reading', enabled: true })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.set.remove', id: 's-1', keepRules: true })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.set.remove', id: 's-1' })).toBe(false);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.list.enable', enabled: false })).toBe(true);
  });

  it('stand still while the whole list is switched off', async () => {
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.list.enable', enabled: false })).toEqual({ ok: true, revision: 2 });
    expect(await rulesDecision({ ...f.scope, accountId: null, collectionId: null }, { ...paper, explicit: false })).toBeNull();
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.list.enable', enabled: true });
    expect(await rulesDecision({ ...f.scope, accountId: null, collectionId: null }, { ...paper, explicit: false })).toMatchObject({ targetNativeId: '30' });
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
    const [rule] = individualRules(await browserRuleStore().load());
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.review', id: rule!.id, accountRuleId: 'rule-arxiv', key: '4:1' }))
      .toMatchObject({ ok: true, rule: { reviewed: [{ accountRuleId: 'rule-arxiv', key: '4:1' }] } });
    expect(await overlap()).toMatchObject({ reviewed: true });
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule({ ruleRevision: '5' })], { revision: 'b-4', settingsRevision: 4 }), NOW);
    expect(await overlap()).toMatchObject({ reviewed: false, reviewKey: '5:1' });
  });

  it('is a duplicate when it files the same pages into the same folder, and nothing once switched off or signed out', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
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

describe('moving a rule to the account (AW-71)', () => {
  beforeEach(async () => {
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    f.authority = async () => ({ credential: { accessToken: 'token' }, session: { sessionId: 'session', replicaLease: { generation: '2' } } });
    await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule({ host: 'example.com' })], { revision: 'b-3', settingsRevision: 3 }), NOW);
  });
  const first = async () => (await automationStateView()).browserRules[0]!;

  it('offers the filled-in web editor only for a rule whose folder is synced', async () => {
    expect(await first()).toMatchObject({ move: null, localOnly: true, moving: false });
    const [rule] = individualRules(await browserRuleStore().load());
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10' }) });
    const view = await first();
    expect(view.localOnly).toBe(false);
    expect(new URL(view.move!.url).searchParams.toString())
      .toBe('collectionId=c_personal&folderId=academic&name=Papers+from+arXiv&combinator=all&condition=siteIs%3Aarxiv.org&from=browser');
    f.credential = null;
    expect(await first()).toMatchObject({ move: null, localOnly: false });
  });

  it('retires once the account’s enabled copy is installed, and says so', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10' }) });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.moving', id: rule!.id })).toMatchObject({ ok: true, rule: { movingSince: NOW } });
    expect(await first()).toMatchObject({ moving: true });
    f.bundle = ruleBundle([compiledRule()], { revision: 'b-4', settingsRevision: 4 });
    await refreshAutomation({ manual: true });
    expect(individualRules(await browserRuleStore().load())).toEqual([]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ kind: 'known.automation.notice', attention: false,
      text: '“Papers from arXiv” now runs from your account, on every device.' });
  });

  it('says a move is stuck after a day, and can keep the rule here instead (U5)', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10' }) });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.moving', id: rule!.id });
    vi.setSystemTime(NOW + MOVING_STALE_MS);
    expect(await first()).toMatchObject({ moving: true, movingStale: false });
    vi.setSystemTime(NOW + MOVING_STALE_MS + 1);
    expect(await first()).toMatchObject({ moving: true, movingStale: true, move: { url: expect.stringContaining('from=browser') } });
    // Signed out, no account copy can arrive: nothing is shown as waiting.
    f.credential = null;
    expect(await first()).toMatchObject({ moving: false, movingStale: false });
    f.credential = { serverOrigin: 'https://colp.example', subject: 'owner' };
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.stay', id: rule!.id })).toMatchObject({ ok: true, rule: { id: rule!.id } });
    expect((individualRules(await browserRuleStore().load()))[0]).not.toHaveProperty('movingSince');
    expect(await first()).toMatchObject({ moving: false, movingStale: false, enabled: true });
    expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.stay', id: 'missing' })).toEqual({ ok: false, error: 'notFound' });
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.stay', id: 'b-1' })).toBe(true);
    expect(validBrowserRuleCommand({ kind: 'known.automation.browser.stay', id: 'b-1', moving: false })).toBe(false);
  });

  it('keeps filing while the account has only something else, or nothing in force', async () => {
    const [rule] = individualRules(await browserRuleStore().load());
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10' }) });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.moving', id: rule!.id });
    // The account changed the conditions before turning it on.
    f.bundle = ruleBundle([compiledRule({ definition: { match: { kind: 'all', items: [{ kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' },
      { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' }] } } })], { revision: 'b-4', settingsRevision: 4 });
    await refreshAutomation({ manual: true });
    expect(individualRules(await browserRuleStore().load())).toHaveLength(1);
    f.bundle = ruleBundle([], { paused: true, revision: 'b-5', settingsRevision: 5 });
    await refreshAutomation({ manual: true });
    expect(individualRules(await browserRuleStore().load())).toHaveLength(1);
    // A rule that was never moved is not retired by a duplicate.
    f.bundle = ruleBundle([compiledRule()], { revision: 'b-6', settingsRevision: 6 });
    await handleBrowserRuleCommand({ kind: 'known.automation.browser.save', id: rule!.id, draft: draft({ folderNativeId: '10', name: 'Edited' }) });
    await refreshAutomation({ manual: true });
    expect(individualRules(await browserRuleStore().load())).toHaveLength(1);
  });
});
