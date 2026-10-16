// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parseHubRoute } from '../src/options-router.js';
import { defaultView, hubHash } from '../src/options-tabs.js';
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

it('opens the logout dialog from #sign-out and only sends logout on confirm', async () => {
  const html = await readFile(resolve(import.meta.dirname, '../options.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  let actionClick: ((event: { isTrusted: boolean }) => void) | undefined;
  const originalAdd = HTMLButtonElement.prototype.addEventListener;
  HTMLButtonElement.prototype.addEventListener = function (
    this: HTMLButtonElement,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (this.id === 'sign-out' && type === 'click') {
      actionClick = listener as (event: { isTrusted: boolean }) => void;
    }
    return originalAdd.call(this, type, listener, options);
  };
  const sent: Array<{ kind?: string }> = [];
  const signedOut = { status: 'signed_out', environment: 'production', serverOrigin: 'https://know-n.com' };
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (message: { kind?: string }) => {
        sent.push(message);
        if (message.kind === 'known.bookmark.preferences.get') {
          return { ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: false } };
        }
        if (message.kind === 'known.remoteDelete.pending.list') {
          return { ok: true, pending: [], pendingCount: 0, policy: 'apply', casVersion: 0, conflictPending: false, conflictHref: '' };
        }
        if (message.kind === 'known.ingress.diagnostics') return { ok: true, diagnostics: [] };
        return { ok: true, state: signedOut };
      }),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn() },
    },
    tabs: { create: vi.fn(), query: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    bookmarks: { getTree: vi.fn(async () => []), onCreated: { addListener: vi.fn() }, onChanged: { addListener: vi.fn() }, onMoved: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  await import('../src/options.js');
  HTMLButtonElement.prototype.addEventListener = originalAdd;
  await Promise.resolve();
  const dialog = () => document.getElementById('logout-dialog') as HTMLDialogElement | null;
  sent.length = 0;
  actionClick!({ isTrusted: true });
  expect(dialog()?.open).toBe(true);
  expect(dialog()!.textContent).toContain('signing out here also signs you out of Know-N on the web');
  expect(sent.some((message) => message.kind === 'known.auth.logout')).toBe(false);
  document.getElementById('logout-cancel')!.click();
  expect(dialog()).toBeNull();
  expect(sent.some((message) => message.kind === 'known.auth.logout')).toBe(false);
  actionClick!({ isTrusted: true });
  expect(dialog()?.open).toBe(true);
  document.getElementById('logout-confirm')!.click();
  await vi.waitFor(() => {
    expect(sent.some((message) => message.kind === 'known.auth.logout')).toBe(true);
  });
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
