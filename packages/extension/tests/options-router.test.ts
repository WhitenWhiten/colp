// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHubRoute } from '../src/options-router.js';
import { defaultView, hubHash } from '../src/options-tabs.js';
import { bookmarkPreferencesScopeKey } from '../src/bookmark-preferences.js';
import { COLLECTION_BINDING, LIBRARY_STATE } from '../src/library.js';
import { manifest as syncManifest } from './auth-shell-fixture.js';
/* Each pane's sections are real tab panels now, so a retired hash selects a
   tab rather than scrolling down a merged page. `anchor` survives only for
   the one deep link that targets a row inside a panel. */
it('maps the retired panes onto the tab that replaced them', () => {
  expect(parseHubRoute('#account')).toMatchObject({ pane: 'account', view: 'session', hash: '#account' });
  expect(parseHubRoute('#account/session')).toMatchObject({ pane: 'account', view: 'session', hash: '#account' });
  expect(parseHubRoute('#saving/overview')).toMatchObject({ pane: 'history', hash: '#history' });
  expect(parseHubRoute('#saving')).toMatchObject({ pane: 'saving', hash: '#saving' });
  expect(parseHubRoute('#sync')).toMatchObject({ pane: 'sync', view: 'folders', hash: '#sync/folders' });
  expect(parseHubRoute('#bookmarks')).toMatchObject({ pane: 'bookmarks', hash: '#bookmarks' });
  for (const [legacy, view] of [['folders', 'folders'], ['import', 'import']] as const) {
    expect(parseHubRoute(`#${legacy}`)).toMatchObject({ pane: 'sync', view, hash: `#sync/${view}` });
    expect(parseHubRoute(`#${legacy}`).anchor).toBeUndefined();
  }
  expect(parseHubRoute('#credits')).toMatchObject({ pane: 'account', view: 'credits', hash: '#account/credits' });
  expect(parseHubRoute('#sync-center')).toMatchObject({ pane: 'sync', view: 'center', hash: '#sync/center' });
  expect(parseHubRoute('#capture/history')).toMatchObject({ pane: 'history', hash: '#history' });
  // The confirmation deep link keeps its literal hash: native-wait-ui reads
  // location.hash to tell a linked open from an ordinary one.
  expect(parseHubRoute('#native-wait-settings')).toMatchObject({ pane: 'sync', view: 'center', hash: '#native-wait-settings', anchor: 'native-wait-settings' });
  // An unknown view inside a known pane falls back to that pane's default.
  expect(parseHubRoute('#sync/nonsense')).toMatchObject({ pane: 'sync', view: 'folders' });
});
it('keeps only supported task/filter parameters and normalizes unknown routes without URL data', () => {
  const task = '12345678-1234-4123-8123-123456789abc';
  const route = parseHubRoute(`#history?task=${task}&status=attention&url=https://private.example&token=secret`);
  expect(route.params.get('task')).toBe(task); expect(route.params.get('status')).toBe('attention');
  expect(route.hash).not.toContain('private'); expect(route.hash).not.toContain('secret');
  expect(parseHubRoute('#missing').hash).toBe(hubHash('bookmarks', defaultView('bookmarks')));
  expect(parseHubRoute('').hash).toBe('#bookmarks');
});

describe.each(['signed_out', 'connected'] as const)('options page opened %s', initialStatus => {
  let runLogout: () => Promise<void>;
  let dispose: (() => Promise<void>) | undefined;
  // Load the real page graph once per browser session as a suite fixture.
  // Cold transforms under parallel workers belong to page initialization.
  beforeAll(async () => {
    vi.resetModules();
    const html = await readFile(resolve(import.meta.dirname, '../options.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
    const originalUrl = location.href;
    const originalActivation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    const pageListeners: Array<() => void> = [];
    const windowAdd = window.addEventListener;
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      windowAdd.call(window, type, listener, options);
      pageListeners.push(() => window.removeEventListener(type, listener, options));
    });
    const documentAdd = document.addEventListener;
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      documentAdd.call(document, type, listener, options);
      pageListeners.push(() => document.removeEventListener(type, listener, options));
    });
    const clearTimers: Array<() => void> = [];
    const globalInterval = globalThis.setInterval.bind(globalThis);
    const globalTimeout = globalThis.setTimeout.bind(globalThis);
    const domTimers: Pick<Window, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'> = window;
    const windowInterval = domTimers.setInterval.bind(window);
    const windowTimeout = domTimers.setTimeout.bind(window);
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      const id = globalInterval(handler, timeout, ...args);
      clearTimers.push(() => globalThis.clearInterval(id));
      return id;
    });
    // happy-dom owns window timers separately from the Node timer globals.
    vi.spyOn(domTimers, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      const id = windowInterval(handler, timeout, ...args);
      clearTimers.push(() => domTimers.clearInterval(id));
      return id;
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      const id = globalTimeout(handler, timeout, ...args);
      clearTimers.push(() => globalThis.clearTimeout(id));
      return id;
    });
    vi.spyOn(domTimers, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      const id = windowTimeout(handler, timeout, ...args);
      clearTimers.push(() => domTimers.clearTimeout(id));
      return id;
    });
    let actionClick: ((event: { isTrusted: boolean }) => void) | undefined;
    const originalAdd = HTMLButtonElement.prototype.addEventListener;
    vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(function (
      this: HTMLButtonElement, type, listener, options,
    ) {
      if (this.id === 'sign-out' && type === 'click') actionClick = listener as (event: { isTrusted: boolean }) => void;
      return originalAdd.call(this, type, listener, options);
    });
    const sent: Array<{ kind?: string }> = [];
    const signedOut = { status: 'signed_out' as const, environment: 'production' as const, serverOrigin: 'https://know-n.com' };
    const signedIn = { ...signedOut, status: 'connected' as const, accountLabel: 'Test account' };
    let currentState: typeof signedOut | typeof signedIn = initialStatus === 'connected' ? signedIn : signedOut;
    const navigationIdentities: string[] = [];
    const stored = { [COLLECTION_BINDING]: 'test-library', [LIBRARY_STATE]: {
      status: 'ready', accountId: 'test-account', serverOrigin: signedOut.serverOrigin,
      library: { id: 'test-library', title: 'Test library', library: true, rootNodeId: 'test-root',
        bookmarksBarId: 'test-bar', otherBookmarksId: 'test-other' },
    } };
    const unexpectedHttp: string[] = [];
    const httpRequests: string[] = [];
    const manifestResponse = new Response(JSON.stringify(syncManifest(signedOut.serverOrigin)), {
      headers: { 'content-type': 'application/vnd.collection-protocol.manifest+json;version=0.2' },
    });
    const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      httpRequests.push(`${method} ${url}`);
      if (method === 'GET' && url === 'https://know-n.com/.well-known/collection-protocol') return manifestResponse;
      if (initialStatus === 'connected' && method === 'GET') {
        if (url === 'https://know-n.com/api/v1/session') return Response.json({ authenticated: true });
        if (url === 'https://know-n.com/api/v1/me') return Response.json({ profile: { avatarUrl: null } });
        if (url === 'https://know-n.com/api/v1/auth/get-session') return Response.json({ user: { id: 'test-account' } });
        if (url === 'https://know-n.com/api/v1/me/capture-capabilities') return Response.json({
          automaticFolderAvailable: false, automaticTagsAvailable: false });
        if (url === 'https://know-n.com/api/v1/me/credits') return new Response(null, { status: 204 });
      }
      unexpectedHttp.push(`${method} ${url}`);
      throw new Error(`Undeclared options HTTP request: ${method} ${url}`);
    });
    const manifestReads = () => httpRequests.filter(request => request === 'GET https://know-n.com/.well-known/collection-protocol');
    const expectedHttp = [
      'GET https://know-n.com/.well-known/collection-protocol',
      ...(initialStatus === 'connected' ? [
        // The sidebar and Account panel independently hydrate the same profile.
        'GET https://know-n.com/api/v1/session', 'GET https://know-n.com/api/v1/session',
        'GET https://know-n.com/api/v1/me', 'GET https://know-n.com/api/v1/me',
        'GET https://know-n.com/api/v1/auth/get-session', 'GET https://know-n.com/api/v1/auth/get-session',
        'GET https://know-n.com/api/v1/me/capture-capabilities', 'GET https://know-n.com/api/v1/me/credits',
      ] : []),
    ].sort();
    vi.stubGlobal('fetch', fetchFixture);
    let finishLogout!: (response: { ok: true; state: typeof signedOut }) => void;
    const logout = new Promise<{ ok: true; state: typeof signedOut }>(done => {
      finishLogout = response => { currentState = signedOut; done(response); };
    });
    const remove = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (message: { kind?: string }) => {
      sent.push(message);
      if (message.kind === 'known.auth.logout') return logout;
      if (message.kind === 'known.capture.navigation.get') {
        const identity = bookmarkPreferencesScopeKey(signedOut.serverOrigin, currentState.status === 'connected' ? 'test-account' : null);
        navigationIdentities.push(identity); return { ok: true, identity, hash: '#account' };
      }
      if (message.kind === 'known.sync.rejoinDecisions.get') return { ok: true, decisions: [] };
      if (message.kind === 'known.roots.get') return { ok: true, view: { viewId: 'root-view', status: 'ready', roots: [] } };
      if (message.kind === 'known.firstRun.status') return { ok: true, firstRun: 'completed', phase: 'completed' };
      if (message.kind === 'known.sync.progress.get') return { ok: true, progress: null };
      if (message.kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'sleeping', hasPendingWork: false } };
      if (message.kind === 'known.favicon.policy') return { ok: true, policy: { newDefault: 'none' } };
      if (message.kind === 'known.bookmark.preferences.get') {
        return { ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: false } };
      }
      if (message.kind === 'known.remoteDelete.pending.list') {
        return { ok: true, pending: [], pendingCount: 0, policy: 'apply', casVersion: 0, conflictPending: false, conflictHref: '' };
      }
      if (message.kind === 'known.ingress.diagnostics') return { ok: true, diagnostics: [] };
      return { ok: true, state: currentState };
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      storage: {
        local: { get: vi.fn(async () => stored), set: vi.fn(async () => undefined), remove },
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
        onChanged: { addListener: vi.fn() },
      },
      tabs: { create: vi.fn(), query: vi.fn(async () => []) },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true),
        onAdded: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
      bookmarks: { getTree: vi.fn(async () => []), onCreated: { addListener: vi.fn() }, onChanged: { addListener: vi.fn() }, onMoved: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
      alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    });
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    const flushRender = () => new Promise<void>(done => setTimeout(done, 0));
    dispose = async () => {
      finishLogout({ ok: true, state: signedOut });
      // Resolve outstanding message/render jobs before globals or the DOM go away.
      await flushRender();
      window.dispatchEvent(new Event('pagehide'));
      for (const clear of clearTimers) clear();
      for (const removeListener of pageListeners) removeListener();
      history.replaceState(null, '', originalUrl);
      await flushRender();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      if (originalActivation) Object.defineProperty(navigator, 'userActivation', originalActivation);
      else Reflect.deleteProperty(navigator, 'userActivation');
      document.body.replaceChildren();
      for (const key of Object.keys(document.body.dataset)) delete document.body.dataset[key];
    };
    history.replaceState(null, '', '#account');
    await import('../src/options.js');
    await vi.waitFor(() => {
      expect(document.body.dataset.state).toBe(initialStatus);
      expect(remove).toHaveBeenCalledWith('known.onboarding.installed.v1');
      expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.capture.navigation.get' });
      expect(manifestReads()).toHaveLength(1);
      expect([...httpRequests].sort()).toEqual(expectedHttp);
      if (initialStatus === 'connected') {
        expect(document.body.dataset.library).toBe('ready');
        expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.sync.rejoinDecisions.get' });
      }
    });
    await flushRender();
    runLogout = async () => {
      expect(manifestReads()).toHaveLength(1);
      expect(unexpectedHttp).toEqual([]);
      expect(sent.filter(message => message.kind === 'known.sync.rejoinDecisions.get')).toEqual(
        initialStatus === 'connected' ? [{ kind: 'known.sync.rejoinDecisions.get' }] : []);
      const dialog = () => document.getElementById('logout-dialog') as HTMLDialogElement | null;
      const logoutRequests = () => sent.filter(message => message.kind === 'known.auth.logout');
      expect(actionClick).toBeTypeOf('function');
      actionClick!({ isTrusted: true });
      expect(dialog()?.open).toBe(true);
      expect(dialog()!.textContent).toContain('signing out here also signs you out of Know-N on the web');
      expect(logoutRequests()).toHaveLength(0);
      document.getElementById('logout-cancel')!.click();
      expect(dialog()).toBeNull();
      expect(logoutRequests()).toHaveLength(0);
      actionClick!({ isTrusted: true });
      expect(dialog()?.open).toBe(true);
      document.getElementById('logout-confirm')!.click();
      await vi.waitFor(() => expect(logoutRequests()).toHaveLength(1));
      expect((document.getElementById('primary-action') as HTMLButtonElement).disabled).toBe(true);
      const identityReads = sent.filter(message => message.kind === 'known.capture.navigation.get').length;
      const decisionReads = sent.filter(message => message.kind === 'known.sync.rejoinDecisions.get').length;
      finishLogout({ ok: true, state: signedOut });
      await vi.waitFor(() => {
        expect(dialog()).toBeNull();
        expect(document.body.dataset.state).toBe('signed_out');
        expect((document.getElementById('primary-action') as HTMLButtonElement).disabled).toBe(false);
        expect(document.getElementById('account')?.textContent).toBe('Not signed in');
        expect(sent.filter(message => message.kind === 'known.capture.navigation.get')).toHaveLength(identityReads + 1);
      });
      await flushRender();
      expect(logoutRequests()).toEqual([{ kind: 'known.auth.logout', userGesture: true }]);
      expect(navigationIdentities.at(-1)).toBe(bookmarkPreferencesScopeKey(signedOut.serverOrigin, null));
      expect(sent.filter(message => message.kind === 'known.sync.rejoinDecisions.get')).toHaveLength(decisionReads);
      expect(manifestReads()).toHaveLength(1);
      expect([...httpRequests].sort()).toEqual(expectedHttp);
      expect(unexpectedHttp).toEqual([]);
    };
  });
  afterAll(async () => { await dispose?.(); });
  it('cancels logout, then awaits confirmation and the signed-out identity', async () => { await runLogout(); });
});

it('redirects the retired Saving tabs, Preferences and Diagnostics onto the page that owns their content', () => {
  for (const pane of ['saving', 'capture']) {
    expect(parseHubRoute('#' + pane + '/history')).toMatchObject({ pane: 'history', hash: '#history' });
    expect(parseHubRoute('#' + pane + '/settings')).toMatchObject({ pane: 'saving', hash: '#saving' });
    expect(parseHubRoute('#' + pane + '/diagnostics')).toMatchObject({ pane: 'help', hash: '#help?category=capture' });
  }
  expect(parseHubRoute('#saving/history?task=12345678-1234-4123-8123-123456789abc').hash).toBe('#history?task=12345678-1234-4123-8123-123456789abc');
  for (const [section, hash] of [['capture', '#saving'], ['bookmarks', '#saving'], ['classification', '#ai'], ['local-classification', '#ai'],
    ['language', '#general'], ['permissions', '#general'], ['subscriptions', '#subscriptions/list'], ['directories', '#subscriptions/list']] as const) {
    expect(parseHubRoute('#preferences?section=' + section).hash).toBe(hash);
  }
  expect(parseHubRoute('#preferences').hash).toBe('#saving');
  expect(parseHubRoute('#diagnostics').hash).toBe('#help');
  expect(parseHubRoute('#diagnostics?category=sync')).toMatchObject({ pane: 'help', hash: '#help?category=sync' });
  expect(parseHubRoute('#subscriptions/new')).toMatchObject({ pane: 'subscriptions', view: 'new' });
  expect(parseHubRoute('#subscriptions/detail?mapping=12345678-1234-4123-8123-123456789abc').params.has('mapping')).toBe(true);
  expect(parseHubRoute('#account?return=https://evil.test').params.has('return')).toBe(false);
  expect(parseHubRoute('#account?return=subscriptions/new').params.get('return')).toBe('subscriptions/new');
  expect(parseHubRoute('#account?return=help').params.get('return')).toBe('help');
  expect(parseHubRoute('#help?category=capture')).toMatchObject({ pane: 'help', hash: '#help?category=capture' });
});
