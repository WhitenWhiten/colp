import { readFile } from 'node:fs/promises';
import { expect, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { PublicAuthState, PublicRangePreview, PublicRootView } from '../src/types.js';
import { config, EXTENSION_ID, EXTENSION_ORIGIN, manifest } from './auth-shell-fixture.js';

export const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const COLLECTION = 'known.sync.collection.v1', LIBRARY = 'known.sync.library.v1';
export const ORIGIN = 'https://know-n.com', NEXT_ORIGIN = 'https://private.example';
export const signedOut: PublicAuthState = { status: 'signed_out', environment: 'production', serverOrigin: ORIGIN };
export const connected: PublicAuthState = { ...signedOut, status: 'connected', accountLabel: 'Reader <reader@example.test>', sessionExpiresAt: '2099-01-01T00:00:00Z' };

/** A browser document with the actual options entry graph. All HTTP is declared
 * by method and URL. Trusted DOM events and chrome events are browser input ports. */
export async function mountOptions(initial: PublicAuthState = signedOut) {
  vi.resetModules();
  const html = await readFile('options.html', 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const initialUrl = location.href;
  history.replaceState(null, '', '#account');
  const disposals: Array<() => void> = [];
  const activation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const trusted = new Map<HTMLElement, Map<string, EventListener[]>>();
  const elementAdd = HTMLElement.prototype.addEventListener;
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (typeof listener === 'function') {
      const events = trusted.get(this) ?? new Map<string, EventListener[]>();
      const list = events.get(type) ?? []; list.push(listener as EventListener); events.set(type, list); trusted.set(this, events);
    }
    return elementAdd.call(this, type, listener, options);
  });
  const windowEvents = new Map<string, EventListener[]>();
  const windowAdd = window.addEventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    windowAdd.call(window, type, listener, options);
    if (typeof listener === 'function') { const list = windowEvents.get(type) ?? []; list.push(listener as EventListener); windowEvents.set(type, list); }
    disposals.push(() => window.removeEventListener(type, listener, options));
  });
  const documentAdd = document.addEventListener;
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    documentAdd.call(document, type, listener, options); disposals.push(() => document.removeEventListener(type, listener, options));
  });
  const domTimers: Pick<Window, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> = window;
  // Capture both browser and Node implementations before either is replaced;
  // happy-dom exposes aliases for some timer methods.
  const timers = [globalThis, domTimers].map(target => ({ target,
    originalTimeout: target.setTimeout.bind(target), originalInterval: target.setInterval.bind(target) }));
  for (const { target, originalTimeout, originalInterval } of timers) {
    vi.spyOn(target, 'setTimeout').mockImplementation((handler, wait, ...args) => {
      const id = originalTimeout(handler, wait, ...args); disposals.push(() => target.clearTimeout(id)); return id;
    });
    vi.spyOn(target, 'setInterval').mockImplementation((handler, wait, ...args) => {
      const id = originalInterval(handler, wait, ...args); disposals.push(() => target.clearInterval(id)); return id;
    });
  }
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  const library = { id: 'options-library', title: 'Library', library: true, rootNodeId: 'root', bookmarksBarId: 'bar', otherBookmarksId: 'other' };
  await local.set({ [COLLECTION]: library.id, [LIBRARY]: { status: 'ready', accountId: 'reader', serverOrigin: ORIGIN, library },
    'known.onboarding.installed.v1': 'installed' });
  const storageListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void> = [];
  const messageListeners: Array<(message: unknown) => unknown> = [];
  const permissionListeners: Array<() => void> = [];
  const controls = { state: initial, nextAuth: connected, loginFailure: undefined as string | undefined,
    otpFailure: false, rejectRefresh: false, firstRun: 'completed' as 'none' | 'completed', deniedServer: false,
    rangeFailure: false, omitRangeReceipt: false };
  const rootView: PublicRootView = { viewId: 'options-roots', status: 'ready', roots: [
    { ref: 'bar', kind: 'bookmarks_bar', title: 'Bar', depth: 0, selected: true, managed: false, privateLocal: false, bookmarkCount: 1, folderCount: 0 },
  ] };
  const rangePreview: PublicRangePreview = { previewId: 'options-range', treeDigest: 'range-tree', boundaryVersion: '1',
    bookmarkCount: 1, folderCount: 0, skippedCount: 0, addedCount: 0, addedBookmarkCount: 0, additions: [],
    removedCount: 0, shiftCount: 0, expiresAt: Date.now() + 60_000, warnings: [], shifts: [], removals: [] };
  const requests: Array<{ kind: string; [key: string]: unknown }> = [], unexpectedMessages: string[] = [];
  const send = vi.fn(async (message: { kind: string; [key: string]: unknown }): Promise<unknown> => {
    requests.push(structuredClone(message));
    if (message.kind === 'known.auth.status') return { ok: true, state: controls.state };
    if (message.kind === 'known.auth.refresh') {
      if (controls.rejectRefresh) throw new Error('message_port_closed');
      controls.state = controls.nextAuth; return { ok: true, state: controls.state };
    }
    if (message.kind === 'known.auth.login') {
      controls.state = controls.loginFailure ? { ...signedOut, status: 'error', errorCode: controls.loginFailure } : controls.nextAuth;
      return controls.loginFailure ? { ok: false, state: controls.state, error: controls.loginFailure } : { ok: true, state: controls.state };
    }
    if (message.kind === 'known.auth.send-otp') return controls.otpFailure
      ? { ok: false, error: 'rate_limited', state: { ...signedOut, errorCode: 'rate_limited' } } : { ok: true, state: controls.state };
    if (message.kind === 'known.auth.logout' || message.kind === 'known.server.disconnect') {
      controls.state = { ...signedOut, serverOrigin: typeof message.nextOrigin === 'string' ? message.nextOrigin : controls.state.serverOrigin };
      return { ok: true, state: controls.state };
    }
    if (message.kind === 'known.capture.navigation.get') return { ok: true,
      identity: `${controls.state.serverOrigin}:${controls.state.status}`, hash: '#account' };
    if (message.kind === 'known.capture.navigation.set') return { ok: true };
    if (message.kind === 'known.sync.rejoinDecisions.get') return { ok: true, decisions: [] };
    if (message.kind === 'known.roots.get') return { ok: true, view: rootView };
    if (message.kind === 'known.roots.preview') return controls.rangeFailure
      ? { ok: false, error: 'permission_required' } : { ok: true, preview: rangePreview };
    if (message.kind === 'known.roots.confirm') return { ok: true, view: rootView,
      ...(!controls.omitRangeReceipt ? { confirmation: { confirmationId: message.confirmationId, state: 'committed' } } : {}) };
    if (message.kind === 'known.roots.boundaries') return { ok: true, boundaries: { selected: ['bar'], privateLocal: [] } };
    if (message.kind === 'known.firstRun.status') return controls.state.status === 'connected'
      ? { ok: true, firstRun: controls.firstRun, phase: controls.firstRun === 'completed' ? 'completed' : 'draft' }
      : { ok: false, error: 'not_connected' };
    if (message.kind === 'known.firstRun.preview') return { ok: true, previewId: 'options-preview', treeDigest: 'options-tree',
      boundaryVersion: '1', bookmarkCount: 1, folderCount: 0, skippedCount: 0, warnings: [] };
    if (message.kind === 'known.firstRun.confirm') { controls.firstRun = 'completed'; return { ok: true, firstRun: 'completed', phase: 'completed' }; }
    if (message.kind === 'known.sync.progress.get') return { ok: true, progress: null };
    if (message.kind === 'known.localImport.status') return { ok: true, status: null };
    if (message.kind === 'known.import.status') return { ok: false, error: 'plan_not_found' };
    if (message.kind === 'known.nativeWait.list') return { ok: true, waits: [] };
    if (message.kind === 'known.sync.attention.get') return { ok: true, attention: {
      recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
      nativeWaitPending: false, waitCount: 0, terminal: false, issues: [], issueCount: 0 } };
    if (message.kind === 'known.metadataSync.status') return controls.state.status === 'connected'
      ? { ok: true, collectionId: library.id, mode: 'local-only', consentRequired: true } : { ok: false, error: 'not_connected' };
    if (message.kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'idle', hasPendingWork: false } };
    if (message.kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'enabled' } };
    if (message.kind === 'known.favicon.policy') return { ok: true, policy: { newDefault: 'none' } };
    if (message.kind === 'known.bookmark.preferences.get') return { ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: false } };
    if (message.kind === 'known.remoteDelete.pending.list' || message.kind === 'known.remoteDelete.policy.get') return { ok: true, pending: [], pendingCount: 0, policy: 'apply', casVersion: 0, conflictPending: false, conflictHref: '' };
    if (message.kind === 'known.sync.ingressDiagnostics.get') return { ok: true, diagnostics: [] };
    if (message.kind === 'known.connectivity.online') return { ok: true };
    unexpectedMessages.push(message.kind); throw new Error(`Undeclared options message ${message.kind}`);
  });
  const http: string[] = [], unexpectedHttp: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input), method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    http.push(`${method} ${url}`);
    if (method === 'GET' && url === `${EXTENSION_ORIGIN}/generated-config.json`) return Response.json(config());
    for (const origin of [ORIGIN, NEXT_ORIGIN]) {
      if (method !== 'GET') continue;
      if (url === `${origin}/.well-known/collection-protocol`) return Response.json(manifest(origin));
      if (url === `${origin}/api/v1/session`) return Response.json({ authenticated: true });
      if (url === `${origin}/api/v1/me`) return Response.json({ profile: { avatarUrl: null } });
      if (url === `${origin}/api/v1/auth/get-session`) return Response.json({ user: { id: 'reader' } });
      if (url === `${origin}/api/v1/me/capture-capabilities`) return Response.json({ automaticFolderAvailable: false, automaticTagsAvailable: false });
      if (url === `${origin}/api/v1/me/credits`) return new Response(null, { status: 404 });
    }
    unexpectedHttp.push(`${method} ${url}`); throw new Error(`Undeclared options HTTP ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const silentEvent = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const nativeWrite = vi.fn(async () => { throw new Error('options auth must not mutate native bookmarks'); });
  vi.stubGlobal('chrome', { runtime: { id: EXTENSION_ID, sendMessage: send, getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`,
    getManifest: () => ({ version: '1.0.0' }), onMessage: { addListener: (listener: (message: unknown) => unknown) => messageListeners.push(listener) } },
    storage: { local, session, managed: { get: async () => ({}) }, onChanged: { addListener: (listener: typeof storageListeners[number]) => storageListeners.push(listener) } },
    tabs: { create: vi.fn(async () => undefined), query: async () => [] },
    permissions: { contains: async () => true, request: async () => !controls.deniedServer,
      onAdded: { addListener: (listener: () => void) => permissionListeners.push(listener) }, onRemoved: silentEvent() },
    bookmarks: { getTree: async () => [], create: nativeWrite, update: nativeWrite, move: nativeWrite, remove: nativeWrite,
      onCreated: silentEvent(), onChanged: silentEvent(), onMoved: silentEvent(), onRemoved: silentEvent() },
    alarms: { create: vi.fn(), onAlarm: silentEvent() },
  });
  const flush = () => new Promise<void>(done => setTimeout(done, 0));
  const close = async () => {
    try {
      await flush(); window.dispatchEvent(new Event('pagehide')); await flush();
      expect(unexpectedHttp).toEqual([]); expect(unexpectedMessages).toEqual([]);
    } finally {
      for (const dispose of disposals.reverse()) dispose();
      history.replaceState(null, '', initialUrl); vi.restoreAllMocks(); vi.unstubAllGlobals();
      if (activation) Object.defineProperty(navigator, 'userActivation', activation); else Reflect.deleteProperty(navigator, 'userActivation');
      document.body.replaceChildren(); for (const key of Object.keys(document.body.dataset)) delete document.body.dataset[key];
    }
  };
  const trustedEvent = (type: string, target: EventTarget, trustedInput: boolean): Event => ({ type, target, currentTarget: target,
    isTrusted: trustedInput, preventDefault() {}, stopPropagation() {} } as unknown as Event);
  try {
    await import('../src/options.js');
    await vi.waitFor(() => {
      expect(document.body.dataset.state).toBe(initial.status);
      expect(http.filter(call => call === `GET ${ORIGIN}/.well-known/collection-protocol`)).toHaveLength(1);
    });
    await vi.waitFor(async () => expect((await local.get('known.onboarding.installed.v1'))['known.onboarding.installed.v1']).toBeUndefined());
    await flush();
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'options fixture initialization failed'); }
    throw error;
  }
  return { controls, local, requests, http, nativeWrite, library, flush, close,
    input(id: string, value: string) { const input = node<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); },
    gesture(id: string, type = 'click', isTrusted = true) {
      const element = node(id), listeners = trusted.get(element)?.get(type); expect(listeners?.length).toBeGreaterThan(0);
      for (const listener of listeners!) listener.call(element, trustedEvent(type, element, isTrusted));
    },
    online(isTrusted = true) { for (const listener of windowEvents.get('online') ?? []) listener.call(window, trustedEvent('online', window, isTrusted)); },
    notice(message: unknown) { for (const listener of messageListeners) listener(message); },
    permissionAdded() { for (const listener of permissionListeners) listener(); },
    async storage(patch: Record<string, unknown>, area = 'local') {
      const old = await local.get(Object.keys(patch)); await local.set(patch);
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: old[key], newValue }]));
      for (const listener of storageListeners) listener(changes, area);
      await flush();
    },
    async navigate(hash: string) { location.hash = hash; window.dispatchEvent(new Event('hashchange')); await flush(); },
  };
}
