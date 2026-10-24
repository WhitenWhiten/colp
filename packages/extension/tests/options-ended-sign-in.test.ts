// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * W2B-P1-2 (UI half) and W2B-P3-4: the options page itself, loaded from options.html with a stubbed worker. An ended sign-in is
 * written where the person looks; a sign-in whose setup failed is painted as the signed-in browser it is, with the failure kept.
 */
type Message = { kind?: string; [key: string]: unknown };
const ORIGIN = 'https://know-n.com';
const state = (status: string, extra: Record<string, unknown> = {}) => ({ status, environment: 'production', serverOrigin: ORIGIN, ...extra });

function defaultAnswer(message: Message): unknown {
  if (message.kind === 'known.bookmark.preferences.get') return { ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: false } };
  if (message.kind === 'known.remoteDelete.pending.list') {
    return { ok: true, pending: [], pendingCount: 0, policy: 'apply', casVersion: 0, conflictPending: false, conflictHref: '' };
  }
  if (message.kind === 'known.ingress.diagnostics') return { ok: true, diagnostics: [] };
  return { ok: false, error: 'not_available', state: state('signed_out') };
}

async function openOptions(answer: (message: Message) => unknown) {
  vi.resetModules();
  const html = await readFile(resolve(import.meta.dirname, '../options.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  // The body element outlives a page: the last page's state would answer the next page's wait.
  document.body.removeAttribute('data-state');
  const clicks = new Map<string, (event: unknown) => void>();
  const originalAdd = HTMLButtonElement.prototype.addEventListener;
  HTMLButtonElement.prototype.addEventListener = function (
    this: HTMLButtonElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'click' && this.id) clicks.set(this.id, listener as (event: unknown) => void);
    return originalAdd.call(this, type, listener, options);
  };
  const sent: Message[] = [];
  const storageListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (message: Message) => { sent.push(message); return answer(message) ?? defaultAnswer(message); }),
      onMessage: { addListener: vi.fn() },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
      onChanged: { addListener: (listener: (typeof storageListeners)[number]) => { storageListeners.push(listener); } },
    },
    tabs: { create: vi.fn(), query: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    bookmarks: { getTree: vi.fn(async () => []), onCreated: { addListener: vi.fn() }, onChanged: { addListener: vi.fn() },
      onMoved: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  // A signed-in page reads the server for the cloud and credits cards; none of that may leave the test.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  try { await import('../src/options.js'); } finally { HTMLButtonElement.prototype.addEventListener = originalAdd; }
  return { sent, clicks, storageListeners };
}

const node = (id: string) => document.getElementById(id) as HTMLElement;
const text = (selector: string) => document.querySelector(selector)!.textContent;
const ENDED_EXPIRED = 'Your session expired. Sign in again. Sync is paused. Your bookmarks and any changes that have not synced yet are kept here.';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('writes an ended sign-in on the Account page, the Sync tab and the sidebar, not only in a toast', async () => {
  await openOptions((message) => message.kind === 'known.auth.status'
    ? { ok: true, state: state('signed_out', { errorCode: 'session_expired' }) } : undefined);
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('signed_out'); expect(text('#account-copy')).toBe(ENDED_EXPIRED); });
  expect(node('account-copy').hidden).toBe(false);
  expect(node('sync-connect').hidden).toBe(false);
  expect(text('#sync-connect .empty-title')).toBe('Sign in again');
  expect(text('#sync-connect .empty-hint')).toBe(ENDED_EXPIRED);
  expect(`${text('#hub-signin')} ${text('#hub-status')}`).toBe('Sign in again to resume sync');
  // The sign-in form is what the person needs, and it is there.
  expect(node('login-panel').hidden).toBe(false);
  expect(node('session-stage').hidden).toBe(true);
  // The toast says it too, once.
  expect(text('.toast-message')).toBe('Your session expired. Sign in again.');
});

it('tells a revoked sign-in from a reconfigured one', async () => {
  await openOptions((message) => message.kind === 'known.auth.status'
    ? { ok: true, state: state('signed_out', { errorCode: 'authentication_required' }) } : undefined);
  await vi.waitFor(() => { expect(text('#account-copy')).toContain('Your access was revoked. Sign in again.'); });
  expect(text('#account-copy')).not.toContain('expired');
});

it('offers Sign in again, not Retry, when the account alert is about a sign-in that is over', async () => {
  for (const errorCode of ['session_expired', 'authentication_required', 'binding_mismatch']) {
    await openOptions((message) => message.kind === 'known.auth.status'
      ? { ok: true, state: state('error', { errorCode, accountLabel: 'ada@example.com' }) } : undefined);
    await vi.waitFor(() => { expect(document.body.dataset.state).toBe('error'); });
    expect(node('account-alert').hidden).toBe(false);
    expect(node('primary-action').textContent).toBe('Sign in again');
    expect(node('primary-action').dataset.action).toBe('login');
  }
  // A failure that trying again can end still says Retry.
  await openOptions((message) => message.kind === 'known.auth.status'
    ? { ok: true, state: state('error', { errorCode: 'server_unavailable', accountLabel: 'ada@example.com' }) } : undefined);
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('error'); });
  expect(node('primary-action').textContent).toBe('Retry');
  expect(node('primary-action').dataset.action).toBe('retry');
});

it('words the first read after the sign-in configuration changed the same way', async () => {
  await openOptions((message) => message.kind === 'known.auth.status'
    ? { ok: true, state: state('error', { errorCode: 'binding_mismatch' }) } : undefined);
  await vi.waitFor(() => { expect(text('#account-copy')).toContain('the sign-in configuration changed. Sign in again.'); });
  expect(text('#sync-connect .empty-title')).toBe('Sign in again');
});

it('leaves a browser that never signed in, or signed out on purpose, with the page’s own words', async () => {
  await openOptions((message) => message.kind === 'known.auth.status' ? { ok: true, state: state('signed_out') } : undefined);
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('signed_out'); });
  expect(text('#account-copy')).toBe('Saving, organizing and backups work without an account. Sign in to sync your library on every device.');
  expect(text('#sync-connect .empty-title')).toBe('Connect this browser');
  expect(text('#sync-connect .empty-hint')).toBe('Sign in to sync and import into your library. Saving, organizing and HTML import work without an account.');
  expect(text('#hub-status')).toBe('for optional sync');
});

it('repaints the ended sign-in in the new language when the language changes', async () => {
  const { storageListeners } = await openOptions((message) => message.kind === 'known.auth.status'
    ? { ok: true, state: state('signed_out', { errorCode: 'session_expired' }) } : undefined);
  await vi.waitFor(() => { expect(text('#account-copy')).toBe(ENDED_EXPIRED); });
  const catalog = Object.fromEntries(Object.entries({
    auth_sessionExpiredSignAgain: 'ZH-EXPIRED', options_signedOutKept: 'ZH-KEPT', options_signInAgain: 'ZH-AGAIN',
    shell_accountSignedOutLede: 'ZH-LEDE', options_connectThisBrowser: 'ZH-CONNECT', options_collectionsSyncedFoldersConfirmations2: 'ZH-HINT',
  }).map(([key, message]) => [key, { message }]));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => catalog })));
  for (const listener of storageListeners) listener({ 'known.ui-language.v1': { newValue: 'zh-CN' } }, 'local');
  // The page re-localizes its static words first (which would put the lede back), then the ended words follow the language.
  await vi.waitFor(() => { expect(text('#account-copy')).toBe('ZH-EXPIRED ZH-KEPT'); });
  expect(text('#sync-connect .empty-title')).toBe('ZH-AGAIN');
  expect(text('#sync-connect .empty-hint')).toBe('ZH-EXPIRED ZH-KEPT');
});

it('paints a sign-in whose setup failed as the signed-in browser it is, and keeps the failure in front of the person', async () => {
  let attempted = false;
  const { sent, clicks } = await openOptions((message) => {
    if (message.kind === 'known.auth.login') {
      attempted = true;
      return { ok: false, error: 'session_invalid', state: state('error', { errorCode: 'session_invalid' }) };
    }
    if (message.kind === 'known.auth.status') {
      return { ok: true, state: attempted ? state('connected', { accountLabel: 'ada@example.com' }) : state('signed_out') };
    }
    if (message.kind === 'known.auth.refresh') return { ok: true, state: state('connected', { accountLabel: 'ada@example.com' }) };
    return undefined;
  });
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('signed_out'); });
  (node('login-email') as HTMLInputElement).value = 'ada@example.com';
  (node('login-password') as HTMLInputElement).value = 'correct horse';
  clicks.get('login-submit')!({ isTrusted: true, preventDefault: () => undefined });
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('connected'); });
  // The page is the signed-in page: the form is gone and the identity is there.
  expect(node('login-panel').hidden).toBe(true);
  expect(node('session-stage').hidden).toBe(false);
  expect(text('#identity-email')).toBe('ada@example.com');
  // The failure is an alert that stays (a toast alone is gone in seconds), with the one action that tries again.
  const setup = 'You are signed in, but Know-N could not finish setting up sync. Try again in a moment.';
  await vi.waitFor(() => { expect(text('#status')).toBe('Signed in, sync is not ready'); });
  expect(node('account-alert').hidden).toBe(false);
  expect(text('#detail')).toBe(setup);
  expect(node('primary-action').hidden).toBe(false);
  expect(node('primary-action').textContent).toBe('Retry');
  expect(node('primary-action').dataset.action).toBe('retry');
  // The toast does not call it a failed sign-in either.
  await vi.waitFor(() => { expect(text('.toast-message')).toBe(setup); });
  expect(sent.filter((message) => message.kind === 'known.auth.login')).toHaveLength(1);
  // Retry asks the worker to try the setup again, and the alert goes once the page is painted from the answer.
  clicks.get('primary-action')!({ isTrusted: true });
  await vi.waitFor(() => { expect(sent.some((message) => message.kind === 'known.auth.refresh')).toBe(true); });
  await vi.waitFor(() => { expect(node('account-alert').hidden).toBe(true); });
});

it('leaves a failed sign-in that stored nothing as the sign-in page the failed answer painted', async () => {
  const { clicks } = await openOptions((message) => {
    if (message.kind === 'known.auth.login') return { ok: false, error: 'invalid_credentials', state: state('signed_out', { errorCode: 'invalid_credentials' }) };
    if (message.kind === 'known.auth.status') return { ok: true, state: state('signed_out') };
    return undefined;
  });
  await vi.waitFor(() => { expect(document.body.dataset.state).toBe('signed_out'); });
  (node('login-email') as HTMLInputElement).value = 'ada@example.com';
  (node('login-password') as HTMLInputElement).value = 'wrong';
  clicks.get('login-submit')!({ isTrusted: true, preventDefault: () => undefined });
  await vi.waitFor(() => { expect(text('.toast-message')).toBe('Username, email or password is incorrect.'); });
  expect(document.body.dataset.state).toBe('signed_out');
  expect(node('login-panel').hidden).toBe(false);
  expect(node('session-stage').hidden).toBe(true);
});
