import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import type { SyncScope } from '../src/sync-state-store.js';
import type { BuildConfig, StoredCredential } from '../src/types.js';

export const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
export const optionsSender = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
export const popupSender = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
export function browserEvent<T extends (...args: any[]) => unknown>() {
  const listeners = new Set<T>();
  return { listeners, addListener: (listener: T) => { listeners.add(listener); },
    removeListener: (listener: T) => { listeners.delete(listener); }, hasListener: (listener: T) => listeners.has(listener),
    emit: (...args: Parameters<T>) => [...listeners].map(listener => listener(...args)) };
}
class StoragePort extends MemoryStorageArea {
  fail?: 'get' | 'set' | 'remove';
  failNext?: 'get' | 'set' | 'remove';
  readonly calls: string[] = [];
  override async get(...args: Parameters<MemoryStorageArea['get']>) {
    this.calls.push('get'); if (this.fail === 'get' || this.failNext === 'get') {
      this.failNext = undefined; throw new Error('storage_unavailable');
    } return super.get(...args);
  }
  override async set(...args: Parameters<MemoryStorageArea['set']>) {
    this.calls.push('set'); if (this.fail === 'set' || this.failNext === 'set') {
      this.failNext = undefined; throw new Error('storage_unavailable');
    } return super.set(...args);
  }
  override async remove(...args: Parameters<MemoryStorageArea['remove']>) {
    this.calls.push('remove'); if (this.fail === 'remove' || this.failNext === 'remove') {
      this.failNext = undefined; throw new Error('storage_unavailable');
    } return super.remove(...args);
  }
}

/** Import the whole worker graph. Chrome, packaged assets, HTTP and IndexedDB
 * are external ports; no domain handler, authority check or queue is mocked. */
export async function liveWorker() {
  vi.resetModules();
  const config = JSON.parse(await readFile(new URL('../config/production.json', import.meta.url), 'utf8')) as BuildConfig;
  const local = new StoragePort(), session = new StoragePort(), managed = new StoragePort();
  const permission = { granted: false };
  const api = honestChrome();
  api.seed({ id: '0', title: '', children: [] });
  api.seed({ id: '1', parentId: '0', index: 0, title: 'Bookmarks', folderType: 'bookmarks-bar' });
  const tree = (id: string): any => { const node = api.getNode(id); if (!node) throw new Error("Can't find bookmark for id.");
    return { ...node, ...(node.url === undefined ? { children: api.all().filter(row => row.parentId === id).map(row => tree(String(row.id))) } : {}) }; };
  const messages = browserEvent<(message: unknown, sender: chrome.runtime.MessageSender, reply: (response: any) => void) => boolean | undefined>();
  const external = browserEvent<(message: unknown, sender: chrome.runtime.MessageSender, reply: (response: any) => void) => boolean | undefined>();
  const startup = browserEvent<() => void>(), installed = browserEvent<(details: chrome.runtime.InstalledDetails) => unknown>();
  const alarms = browserEvent<(alarm: chrome.alarms.Alarm) => void>(), alarmRegistry = new Map<string, object>();
  const online = browserEvent<(event: { isTrusted: boolean }) => void>();
  const notifications: unknown[] = [], opened: object[] = [], requests: string[] = [];
  const nativeEvents = { onCreated: browserEvent(), onChanged: browserEvent(), onMoved: browserEvent(),
    onRemoved: browserEvent(), onChildrenReordered: browserEvent(), onImportBegan: browserEvent(), onImportEnded: browserEvent() };
  const tabs = { fail: false };
  const idbFault = { database: '' };
  const originalTransaction = IDBDatabase.prototype.transaction;
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
    // fake-indexeddb uses this method internally for versionchange; that is
    // not a browser application's transaction() call and must not be faulted.
    if (this.name === idbFault.database && String(args[1]) !== 'versionchange') throw new Error('database_unavailable');
    return originalTransaction.apply(this, args);
  });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('self', { addEventListener: (kind: string, listener: (event: { isTrusted: boolean }) => void) => {
    if (kind === 'online') online.addListener(listener);
  } });
  vi.stubGlobal('chrome', {
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      sendMessage: async (value: unknown) => { notifications.push(value); }, getManifest: () => ({ name: 'Known', version: '0.1.0' }),
      getContexts: async () => [], openOptionsPage: async () => { opened.push({ options: true }); },
      onMessage: messages, onMessageExternal: external, onStartup: startup, onInstalled: installed },
    storage: { local, session: Object.assign(session, { setAccessLevel: async (value: unknown) => {
      assert.deepEqual(value, { accessLevel: 'TRUSTED_CONTEXTS' });
    } }), managed, onChanged: browserEvent() },
    permissions: { contains: async () => permission.granted, onAdded: browserEvent(), onRemoved: browserEvent() },
    bookmarks: { ...api, ...nativeEvents, getTree: async () => [tree('0')], getSubTree: async (id: string) => [tree(id)],
      search: async (query: { url?: string }) => api.all().filter(row => row.url === query.url) },
    alarms: { create: async (name: string, details: object) => { alarmRegistry.set(name, details); },
      get: async (name: string) => alarmRegistry.has(name) ? { name, ...alarmRegistry.get(name) } : undefined,
      clear: async (name: string) => alarmRegistry.delete(name), onAlarm: alarms },
    tabs: { query: async () => { if (tabs.fail) throw new Error('tabs_unavailable'); return []; },
      create: async (details: object) => { if (tabs.fail) throw new Error('tabs_unavailable'); opened.push(details); return { id: 7, ...details }; },
      update: async () => ({ id: 7 }), onRemoved: browserEvent() },
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => ({ id: 1 }) },
    cookies: { get: async () => null, getAll: async () => [], remove: async () => null, onChanged: browserEvent() },
    commands: { onCommand: browserEvent() },
    contextMenus: { onClicked: browserEvent(), create: () => undefined, removeAll: (callback: () => void) => callback() },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    i18n: { getMessage: () => '', getUILanguage: () => 'en' },
  });
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const href = String(url); requests.push(href);
    if (href === `chrome-extension://${extensionId}/generated-config.json`) return Response.json(config);
    if (href.startsWith(`chrome-extension://${extensionId}/_locales/`)) return Response.json({});
    return new Response(null, { status: 503 });
  });
  await import('../src/service-worker.js');
  const runtime = await import('../src/sw/runtime.js');
  await runtime.credentialAreaReady;
  await runtime.workCoordinator.drain();
  await vi.waitFor(() => assert.ok(alarmRegistry.has(runtime.BOOKMARK_RECONCILE_ALARM)));
  assert.equal(messages.listeners.size, 1);
  const listener = [...messages.listeners][0]!;
  async function send(message: unknown, sender: chrome.runtime.MessageSender = optionsSender) {
    const responses: any[] = [];
    const asynchronous = listener(message, sender, response => responses.push(response));
    if (asynchronous !== true) { assert.equal(responses.length, 1, 'synchronous message must reply once'); return responses[0]; }
    await vi.waitFor(() => assert.equal(responses.length, 1), { timeout: 2000 });
    return responses[0];
  }
  async function connect() {
    const credential: StoredCredential = { accessToken: 'controlled-worker-credential', tokenType: 'Bearer',
      expiresAt: Date.now() + 600_000, scope: config.scopes, issuer: config.issuer,
      audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin, subject: 'worker-owner' };
    await runtime.store.saveCredential(credential);
    const binding = await runtime.store.getOrCreateBinding((await runtime.store.fence.capture()).generation);
    const scope: SyncScope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
      accountId: credential.subject!, browserProfileId: binding.browserProfileId, replicaId: binding.replicaId,
      generation: Number(binding.generation), collectionId: 'worker-collection' };
    await local.set({ [runtime.COLLECTION_BINDING]: scope.collectionId });
    await runtime.syncState.registerScope({ ...scope, lifecycle: 'active', firstRun: 'completed', selectedRoots: [], rootStatus: 'ready',
      lease: { leaseId: 'worker-lease', expiresAt: Date.now() + 600_000 }, checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' } });
    assert.deepEqual(await (await import('../src/sw/scope.js')).currentSyncScope(), scope);
    return scope;
  }
  return { config, runtime, local, session, managed, permission, api, nativeEvents, messages, external,
    startup, installed, alarms, alarmRegistry, online, notifications, opened, requests, tabs, listener, send, connect, idbFault,
    async close() {
      local.fail = session.fail = managed.fail = undefined;
      idbFault.database = ''; transactions.mockRestore();
      await runtime.workCoordinator.drain(); runtime.syncState.close();
      await (await import('../src/sw/capture.js')).captureStore.close();
      (await import('../src/capture/browser-history-store.js')).browserHistoryStore.close();
      (await import('../src/automation/indexeddb-store.js')).automationDatabase().close();
      vi.unstubAllGlobals();
    } };
}
