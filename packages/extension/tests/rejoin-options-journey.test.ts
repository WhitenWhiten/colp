// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { bindRejoinDecisions } from '../src/rejoin-decisions-ui.js';
import { handleRejoinDecisionRequest } from '../src/sw/rejoin-decisions.js';
import { handleScopeCommand } from '../src/sw/first-run.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { installRejoinHttp, REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';
import type { RejoinDecisionRequest } from '../src/scope-rejoin-decisions.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';

const state = vi.hoisted(() => ({ fixture: undefined as unknown as Awaited<ReturnType<typeof deletionFixture>>,
  storage: undefined as unknown as MemoryStorageArea, permission: true, loseReply: false,
  messages: [] as RejoinDecisionRequest[], wakes: 0 }));
vi.mock('../src/sw/runtime.js', async () => {
  const { createAuthorityFence, createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  return { syncState: new Proxy({}, { get: (_target, key) => (...args: unknown[]) => {
    const store = state.fixture.getStore();
    return (store[key as keyof typeof store] as (...values: unknown[]) => unknown)(...args);
  } }), sw: { rootViewTokens: undefined },
  store: { loadCredential: async () => ({ accessToken: REJOIN_TOKEN, subject: scope.accountId }),
    loadSession: async () => rejoinSession(scope) }, extensionOrigin: () => 'chrome-extension://journey-test',
  workCoordinator: createExtensionWorkCoordinator(createAuthorityFence({ get: keys => state.storage.get(keys), set: values => state.storage.set(values) })),
  hasBookmarkPermission: async () => state.permission, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope,
  loadConfig: async () => ({ serverOrigin: scope.serverOrigin, manifestUrl: `${scope.serverOrigin}/manifest.json` }) }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: () => { state.wakes += 1; } }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => {} }, recoverBookmarkEvents: async () => {} }));
// The independent subscription database is an empty external boundary here;
// personal-bookmark guards, sync store, decisions and native receipts stay real.
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

installKns05IndexedDb();
let requests: ReturnType<typeof installRejoinHttp>;
beforeEach(async () => {
  state.fixture = await deletionFixture(); state.storage = new MemoryStorageArea();
  state.permission = true; state.loseReply = false; state.messages = []; state.wakes = 0;
  const api = state.fixture.api;
  api.seed({ id: '0', title: '' });
  api.seed({ id: 'native-root', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar' });
  requests = installRejoinHttp(() => scope, () => state.fixture.snapshot().remoteFacts);
  vi.stubGlobal('chrome', { storage: { local: state.storage },
    runtime: { sendMessage: async (message: RejoinDecisionRequest) => {
      state.messages.push(message);
      const response = await handleRejoinDecisionRequest(message);
      if (message.kind.endsWith('.resolve') && state.loseReply) { state.loseReply = false; throw new Error('port_closed'); }
      return response;
    } },
    bookmarks: { ...api, getTree: async () => nativeTree(),
      getSubTree: async (id: string) => nativeTree(id) },
  });
  document.body.innerHTML = '<section id="rejoin-decisions"></section>';
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); state.fixture.getStore().close(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
function nativeTree(id = '0'): ChromeBookmarkNode[] {
  const api = state.fixture.api;
  const visit = (nativeId: string): ChromeBookmarkNode => {
    const node = api.getNode(nativeId);
    if (!node) throw new Error("Can't find bookmark for id.");
    return { ...node, id: String(node.id), title: String(node.title ?? ''),
      children: api.all().filter(row => row.parentId === nativeId).map(row => visit(String(row.id))) };
  };
  return [visit(id)];
}
async function screen() {
  const compared = await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'mount-bar' });
  expect(compared, JSON.stringify(compared)).toMatchObject({ ok: false, error: 'rejoin_pending' });
  const host = { panel: document.getElementById('rejoin-decisions')!, show: vi.fn(), onResolved: vi.fn() };
  const ui = bindRejoinDecisions(host); ui.setLibraryId(scope.collectionId); ui.onConnection(true);
  await vi.waitFor(() => expect(document.querySelector('[data-rejoin-action="keep_remote"]')).not.toBeNull());
  return { ...host, ui };
}

test.each([false, true])('DOM choice reaches the real worker, complete HTTP snapshot and receipts; lost reply=%s', async lost => {
  const f = await screen(); state.loseReply = lost;
  document.querySelector<HTMLButtonElement>('[data-rejoin-action="keep_remote"]')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(state.messages.filter(message => message.kind.endsWith('.resolve'))).toHaveLength(1);
  const stored = state.fixture.getStore();
  const restored = (await stored.getMappingByColpId(scope, 'restore-folder'))!;
  expect((await state.fixture.api.get(restored.nativeId))[0]?.title).toBe('Cloud folder');
  const mappings = new Map((await stored.listMappings(scope)).map(row => [row.nativeId, row.colpId]));
  expect((await state.fixture.api.getChildren(restored.nativeId)).map(row => mappings.get(row.id)))
    .toEqual(state.fixture.children.map(row => row.nodeId));
  expect(state.fixture.api.calls.filter(row => row.kind === 'create')).toHaveLength(3);
  expect((await stored.getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
  expect(await stored.listQueue(scope)).toEqual([]);
  const pages = requests.filter(row => row.url.pathname === '/v1/snapshot');
  expect(pages.some(row => row.url.searchParams.get('pageCursor') === '2')).toBe(true);
  expect(pages.every(row => row.headers.get('Origin') === 'chrome-extension://journey-test')).toBe(true);
  state.fixture.reopen(); await f.ui.refresh();
  expect(state.fixture.api.calls.filter(row => row.kind === 'create')).toHaveLength(3);
  expect(document.querySelector('[data-rejoin-action]')).toBeNull();
  expect(state.wakes).toBeGreaterThan(0);
});

test('a stale cloud copy is refreshed through HTTP; the new copy needs a fresh explicit DOM click', async () => {
  const f = await screen();
  state.fixture.setFacts(state.fixture.snapshot().remoteFacts.map(row => row.nodeId === 'restore-folder'
    ? { ...row, title: 'Newest cloud folder', revision: 'newest-revision' } : row));
  document.querySelector<HTMLButtonElement>('[data-rejoin-action="keep_remote"]')!.click();
  await vi.waitFor(() => expect(f.panel.textContent).toContain('Review the latest items and choose again'));
  await vi.waitFor(() => expect(f.panel.textContent).toContain('Newest cloud folder'));
  expect(state.fixture.api.calls.filter(row => row.kind === 'create')).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('[data-rejoin-action="keep_remote"]')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  const confirms = state.messages.filter(message => message.kind === 'known.sync.rejoinDecisions.resolve');
  expect(confirms).toHaveLength(2); expect(confirms[1]!.token).not.toBe(confirms[0]!.token);
  const restored = (await state.fixture.getStore().getMappingByColpId(scope, 'restore-folder'))!;
  expect((await state.fixture.api.get(restored.nativeId))[0]?.title).toBe('Newest cloud folder');
});

test('permission loss refuses a real decision without creating a native bookmark or accepting evidence', async () => {
  const f = await screen(); state.permission = false;
  document.querySelector<HTMLButtonElement>('[data-rejoin-action="keep_remote"]')!.click();
  await vi.waitFor(() => expect(f.panel.textContent).toContain('Allow bookmark access'));
  expect(state.fixture.api.calls.filter(row => row.kind === 'create')).toHaveLength(0);
  expect((await state.fixture.getStore().listScopeCommandPlans(scope)).filter(row => row.rejoinDecision)
    .every(row => row.phase === 'pending')).toBe(true);
});
