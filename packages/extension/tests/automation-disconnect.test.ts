import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { AUTOMATION_BADGE_KEY } from '../src/action-badge.js';
import { automationOwnerKey, createBundleStore } from '../src/automation/bundle-store.js';
import { BROWSER_PLACEMENTS_KEY } from '../src/automation/browser-rule-store.js';
import { individualRules, RULE_LIST_KEY } from '../src/automation/rule-list-store.js';
import { automationDatabase, createAutomationDatabase, type PlacementIntent } from '../src/automation/indexeddb-store.js';
import { AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY } from '../src/automation/messages.js';
import { SERVER_STATUS_KEY } from '../src/automation/server-status.js';
import { NOW, compiledRule, ruleBundle } from './automation-fixture.js';

/** AW-72 (AC-74): signing out, or in as someone else, takes the account's automation data and leaves this browser's own rules working. */
const f = vi.hoisted(() => ({
  credential: null as null | { serverOrigin: string; subject: string },
  scope: { serverOrigin: 'https://colp.example', accountId: 'owner', authorityGeneration: 1, collectionId: 'c_personal' },
  bundle: null as null | Promise<{ ok: true; body: unknown }>,
  fetched: 0,
  next: null as null | { serverOrigin: string; subject: string },
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://extension',
  store: { loadCredential: async () => f.credential, loadBinding: async () => null, clearAuthority: async () => undefined },
  syncState: { cleanupAccount: async () => undefined,
    getMappingByColpId: async (_scope: unknown, colpId: string) => colpId === 'academic' ? { nativeId: '10', nodeKind: 'folder' } : null,
    getMappingByNativeId: async (_scope: unknown, nativeId: string) => nativeId === '10' ? { colpId: 'academic', nodeKind: 'folder' } : null },
  sw: {}, workCoordinator: { drain: async () => undefined }, COLLECTION_BINDING: 'binding', WELCOME_FLAG: 'welcome',
}));
vi.mock('../src/sw/scope.js', () => ({
  loadConfig: async () => ({ environment: 'test', serverOrigin: 'https://colp.example' }), enforceManagedPolicy: async () => undefined,
  createRuntimeAuth: () => ({ logout: async () => { f.credential = null; return { status: 'signed_out' }; },
    login: async () => { f.credential = f.next; return { status: 'connected' }; }, ensureFreshCredential: async () => f.credential,
    status: async () => ({ status: 'connected' }) }),
  currentSyncScope: async () => ({ ...f.scope, environment: 'test', serverId: 'https://colp.example', browserProfileId: 'profile', replicaId: 'replica-1', generation: 2 }),
  pushSessionAuthority: async () => ({ credential: { accessToken: 'token' }, session: { sessionId: 'session', replicaLease: { generation: '1' } } }),
  ensureSyncScope: vi.fn(), hasBoundCollection: vi.fn(), retire: vi.fn(), scheduleSessionFreshen: vi.fn(),
}));
vi.mock('../src/automation/device-client.js', () => ({ fetchRuleBundle: () => { f.fetched += 1; return f.bundle; },
  acknowledgeRuleBundle: async () => undefined, postIntakeReceipt: async () => ({ ok: false, problem: 'offline' }) }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({ prepareSubscriptionLogout: async () => undefined,
  maintenance: { cleanup: async () => undefined }, wakeSubscriptions: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/personal-sync.js', () => ({ suspendPersonalSyncForLogout: vi.fn() }));
vi.mock('../src/sw/library.js', () => ({ verifyLibraryAvailability: vi.fn(), ensureLibraryBinding: async () => undefined, libraryUnsupported: async () => false, bindLibraryOnStartup: async () => undefined }));
vi.mock('../src/save-context-cache.js', () => ({ clearSaveContextCache: async () => undefined }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope }));
vi.mock('../src/sw/reconcile-alarm.js', () => ({ ensurePeriodicAlarm: async () => undefined }));

import { handle } from '../src/sw/auth.js';
import { automationArea, handleAutomationRequest, refreshAutomation } from '../src/sw/automation.js';
import { browserPlacementLog, browserPreSaveDecision, browserRuleStore, handleBrowserRuleCommand } from '../src/sw/automation-browser.js';

const owner = { serverOrigin: 'https://colp.example', accountId: 'owner' };
const ownerKey = automationOwnerKey(owner), otherKey = automationOwnerKey({ ...owner, accountId: 'other' });
const paper = { url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId: '21' };
const nodes: Record<string, { id: string; title: string; parentId: string }> = {
  10: { id: '10', title: 'Academic', parentId: '1' }, 21: { id: '21', title: 'Inbox', parentId: '1' }, 30: { id: '30', title: 'Papers', parentId: '2' } };
const intent = (intentId: string, key: string) => ({ intentId, ownerKey: key, createdAt: NOW }) as unknown as PlacementIntent;
const logout = () => handle({ kind: 'known.auth.logout', userGesture: true }, { generation: 1, signal: new AbortController().signal });
const match = () => handleAutomationRequest({ kind: 'known.automation.match', ...paper });
const local = () => chrome.storage.local.get(null) as Promise<Record<string, unknown>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, bookmarks: { get: async (id: string) => nodes[id] ? [nodes[id]] : [] },
    runtime: { sendMessage: vi.fn(async () => undefined) },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined } });
  vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
  f.credential = { serverOrigin: owner.serverOrigin, subject: owner.accountId }; f.bundle = null; f.fetched = 0;
  // This browser's rule, and a page it filed.
  expect(await handleBrowserRuleCommand({ kind: 'known.automation.browser.save',
    draft: { name: 'Papers from arXiv', combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }], action: { kind: 'file', folderNativeId: '30' } } })).toMatchObject({ ok: true });
  const [rule] = individualRules(await browserRuleStore().load());
  await browserPlacementLog().logPlacement({ id: 'capture-1', ruleId: rule!.id, ruleName: 'Papers from arXiv', folder: 'Papers', title: 'Earlier', url: 'https://arxiv.org/abs/1', at: NOW });
  // The account's: its bundle, the server's status, receipts and an intent, and what chrome.storage.local caches for it.
  await createBundleStore(automationArea(), owner).install(ruleBundle([compiledRule()], { revision: 'b-3', settingsRevision: 3 }), NOW);
  await automationArea().set(SERVER_STATUS_KEY, { version: 1, ownerKey, fetchedAt: NOW, rules: [], runs: [], lastAttemptAt: NOW, failures: 0, problem: null });
  await automationArea().set(AUTOMATION_RECEIPTS_KEY, [{ version: 1, localReceiptId: 'r-mine', ownerKey }, { version: 1, localReceiptId: 'r-other', ownerKey: otherKey }]);
  await automationDatabase().intents.put(intent('i-mine', ownerKey));
  await automationDatabase().intents.put(intent('i-other', otherKey));
  await chrome.storage.local.set({ 'known.automation.pause.v1': { ownerKey, pausedAt: null, pausedBy: null },
    'known.automation.device.v1': { key: JSON.stringify([ownerKey, 'replica-1']), deviceId: 'device-1' },
    [AUTOMATION_BADGE_KEY]: { text: '2', color: '#000000', title: '2 new results' } });
});
afterEach(() => { automationDatabase().close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('signing out', () => {
  it('removes the account’s bundle, status, receipts, intents, pause, device and badge', async () => {
    expect(await match()).toMatchObject({ match: { ruleName: 'Place research papers in Academic', folderNativeId: '10' } });
    expect(await logout()).toMatchObject({ ok: true });
    expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toBeUndefined();
    expect(await automationArea().get(SERVER_STATUS_KEY)).toBeUndefined();
    // Another account's entries wait for it, as before.
    expect(await automationArea().get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ version: 1, localReceiptId: 'r-other', ownerKey: otherKey }]);
    expect((await automationDatabase().intents.list()).map((item) => item.intentId)).toEqual(['i-other']);
    expect(Object.keys(await local()).filter((key) => key.startsWith('known.automation.') && key !== 'known.automation.changed.v1')).toEqual([]);
  });

  it('keeps this browser’s rules and their log, and a browser rule still places the save', async () => {
    const rules = await automationArea().get(RULE_LIST_KEY), placements = await automationArea().get(BROWSER_PLACEMENTS_KEY);
    await logout();
    expect(await automationArea().get(RULE_LIST_KEY)).toEqual(rules);
    expect(await automationArea().get(BROWSER_PLACEMENTS_KEY)).toEqual(placements);
    // The capture scope still names the account: the bundle itself is gone, so the browser's rule decides.
    expect(await match()).toEqual({ ok: true, match: { outcome: 'placed', ruleName: 'Papers from arXiv', sourceName: null, ruleCount: 1, folderNativeId: '30', folderTitle: 'Papers' } });
    expect(await browserPreSaveDecision({ ...paper, explicit: false })).toMatchObject({ targetNativeId: '30', automation: { source: 'browser', outcome: 'placed', fromNativeId: '21' } });
  });

  it('clears again what a refresh begun before it writes afterwards', async () => {
    let answer!: (value: { ok: true; body: unknown }) => void;
    f.bundle = new Promise((resolve) => { answer = resolve; });
    const refresh = refreshAutomation({ manual: true });
    await vi.waitFor(() => expect(f.fetched).toBe(1));
    await logout();
    expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toBeUndefined();
    answer({ ok: true, body: ruleBundle([compiledRule()], { revision: 'b-4', settingsRevision: 4 }) });
    await refresh;
    await vi.waitFor(async () => expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toBeUndefined());
    expect(await automationArea().get(SERVER_STATUS_KEY)).toBeUndefined();
  });
});

describe('signing in', () => {
  const login = (subject: string, serverOrigin = owner.serverOrigin) => {
    f.next = { serverOrigin, subject };
    return handle({ kind: 'known.auth.login', userGesture: true, method: 'password', email: 'owner@example.test', password: 'secret' },
      { generation: 1, signal: new AbortController().signal });
  };

  it('as another account takes the earlier account’s data and keeps this browser’s rules', async () => {
    const rules = await automationArea().get(RULE_LIST_KEY);
    expect(await login('someone-else')).toMatchObject({ ok: true });
    expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toBeUndefined();
    expect(await automationArea().get(SERVER_STATUS_KEY)).toBeUndefined();
    expect((await automationDatabase().intents.list()).map((item) => item.intentId)).toEqual(['i-other']);
    expect(await chrome.storage.local.get('known.automation.pause.v1')).toEqual({});
    expect(await automationArea().get(RULE_LIST_KEY)).toEqual(rules);
  });

  it('on another server counts as another account', async () => {
    await login('owner', 'https://other.example');
    expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toBeUndefined();
  });

  it('again as the same account keeps its data', async () => {
    await login('owner');
    expect(await automationArea().get(AUTOMATION_BUNDLE_KEY)).toMatchObject({ ownerKey });
    expect(await automationArea().get(SERVER_STATUS_KEY)).toMatchObject({ ownerKey });
  });
});

describe('the store’s account cleanup', () => {
  it('leaves everything alone for an account it holds nothing for', async () => {
    const database = createAutomationDatabase(new IDBFactory());
    await database.area().set(AUTOMATION_RECEIPTS_KEY, [{ version: 1, localReceiptId: 'r-other', ownerKey: otherKey }]);
    await database.area().set(RULE_LIST_KEY, { version: 3, revision: 1, enabled: true, entries: [] });
    await database.intents.put(intent('i-other', otherKey));
    await database.clearAccount(ownerKey);
    expect(await database.area().get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ version: 1, localReceiptId: 'r-other', ownerKey: otherKey }]);
    expect(await database.area().get(RULE_LIST_KEY)).toEqual({ version: 3, revision: 1, enabled: true, entries: [] });
    expect(await database.intents.list()).toHaveLength(1);
    database.close();
  });
});
