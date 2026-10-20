// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLLECTION, LIBRARY, NEXT_ORIGIN, ORIGIN, connected, mountOptions, node, signedOut } from './options-entry-fixture.js';

let f: Awaited<ReturnType<typeof mountOptions>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

describe('options user actions use the real page entry', () => {
  beforeEach(async () => { f = await mountOptions(); });

  test('password login enters first-run setup, and completing it refreshes the saved picker before logout', async () => {
    const page = f!; page.controls.firstRun = 'none';
    page.input('login-email', 'Reader@EXAMPLE.test'); page.input('login-password', 'secret');
    page.gesture('login-submit');
    await vi.waitFor(() => expect(document.body.dataset.state).toBe('connected'));
    await vi.waitFor(() => expect(document.body.dataset.pane).toBe('sync'));
    await vi.waitFor(() => expect(node<HTMLButtonElement>('first-run-start').disabled).toBe(false));
    node('first-run-start').click();
    await vi.waitFor(() => expect(node('first-run-confirm').hidden).toBe(true));
    expect(page.requests.filter(request => request.kind === 'known.auth.login')).toEqual([
      { kind: 'known.auth.login', method: 'password', userGesture: true, email: 'reader@example.test', password: 'secret' },
    ]);
    expect(page.requests.filter(request => request.kind === 'known.firstRun.confirm')).toEqual([
      expect.objectContaining({ previewId: 'options-preview', libraryId: page.library.id }),
    ]);
    expect(node('account-sync-hint').textContent).toContain('your library');
    await page.flush();
    const httpBeforeLogout = [...page.http];
    page.gesture('sign-out'); expect(node<HTMLDialogElement>('logout-dialog').open).toBe(true);
    node('logout-cancel').click();
    expect(page.requests.filter(request => request.kind === 'known.auth.logout')).toHaveLength(0);
    page.gesture('sign-out'); node('logout-confirm').click();
    await vi.waitFor(() => expect(document.body.dataset.state).toBe('signed_out'));
    await page.flush();
    expect(page.requests.filter(request => request.kind === 'known.auth.logout')).toEqual([{ kind: 'known.auth.logout', userGesture: true }]);
    expect(page.http).toEqual(httpBeforeLogout);
    expect(page.http.filter(call => call === `GET ${ORIGIN}/.well-known/collection-protocol`)).toHaveLength(1);
    expect(page.nativeWrite).not.toHaveBeenCalled();
  });

  test.each(['otp', 'google', 'github'] as const)('%s login sends only the explicit selected method', async method => {
    const page = f!;
    if (method === 'otp') {
      node('login-tab-otp').click(); page.input('login-email', 'Reader@example.test');
      page.gesture('login-send-otp');
      await vi.waitFor(() => expect(node('login-send-otp').textContent).toBe('20s'));
      page.input('login-otp-code', '123456'); page.gesture('login-submit');
    } else page.gesture(`login-${method}`);
    await vi.waitFor(() => expect(document.body.dataset.state).toBe('connected'));
    expect(page.requests.filter(request => request.kind === 'known.auth.login')).toEqual([method === 'otp'
      ? { kind: 'known.auth.login', userGesture: true, method: 'otp', email: 'reader@example.test', otp: '123456' }
      : { kind: 'known.auth.login', userGesture: true, method: 'oauth', provider: method }]);
    expect(node('login-panel').hidden).toBe(true);
    expect(node('server').textContent).toBe(ORIGIN);
    expect(page.requests.filter(request => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
  });

  test('rejected password and OTP attempts remain visible and retryable without a false connected state', async () => {
    const page = f!; page.controls.loginFailure = 'invalid_credentials';
    const warnings = vi.spyOn(console, 'warn');
    page.input('login-email', 'reader@example.test'); page.input('login-password', 'wrong'); page.gesture('login-submit');
    await vi.waitFor(() => expect(node('login-password').getAttribute('aria-invalid')).toBe('true'));
    expect(document.body.dataset.state).toBe('error');
    expect(warnings).toHaveBeenCalledWith('Know-N sign-in failed:', 'invalid_credentials');
    expect(node<HTMLButtonElement>('login-submit').disabled).toBe(false);
    page.controls.otpFailure = true; node('login-tab-otp').click(); page.gesture('login-send-otp');
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith('Know-N sign-in failed:', 'rate_limited'));
    expect(node<HTMLButtonElement>('login-send-otp').disabled).toBe(false);
    expect(page.requests.filter(request => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
  });

  test('server replacement validates the declared manifest before disconnecting and persisting the new origin', async () => {
    const page = f!;
    page.input('server-origin', NEXT_ORIGIN); page.gesture('server-origin', 'change');
    await vi.waitFor(() => expect(node<HTMLInputElement>('server-origin').disabled).toBe(false));
    await vi.waitFor(() => expect(node('server').textContent).toBe(NEXT_ORIGIN));
    expect(page.requests.filter(request => request.kind === 'known.server.disconnect')).toEqual([
      { kind: 'known.server.disconnect', userGesture: true, nextOrigin: NEXT_ORIGIN },
    ]);
    expect((await page.local.get('runtimeServerOrigin')).runtimeServerOrigin).toBe(NEXT_ORIGIN);
    // Authorization validation finishes before the new page identity renders;
    // its subsequent edition/capability readers share their separate read.
    expect(page.http.filter(call => call === `GET ${NEXT_ORIGIN}/.well-known/collection-protocol`)).toHaveLength(2);
    expect(page.requests.filter(request => request.kind === 'known.auth.login')).toHaveLength(0);
    expect(page.nativeWrite).not.toHaveBeenCalled();
  });

  test('welcome dismissal requires a trusted click and its Import action opens the actual import dialog', async () => {
    const page = f!;
    expect(node('welcome').hidden).toBe(false);
    page.gesture('dismiss-welcome', 'click', false); expect(node('welcome').hidden).toBe(false);
    page.gesture('dismiss-welcome'); await vi.waitFor(() => expect(node('welcome').hidden).toBe(true));
    node('welcome-import').click();
    expect(node('local-import-file').closest<HTMLDialogElement>('dialog')!.open).toBe(true);
    expect(page.requests.filter(request => request.kind.includes('confirm'))).toEqual([]);
    expect(page.nativeWrite).not.toHaveBeenCalled();
  });
});

describe('options live browser events', () => {
  beforeEach(async () => { f = await mountOptions(connected); });

  test('storage and permission events refresh this library while session-area and unrelated events do not change it', async () => {
    const page = f!;
    await vi.waitFor(() => expect(document.body.dataset.library).toBe('ready'));
    const countRoots = () => page.requests.filter(request => request.kind === 'known.roots.get').length;
    const before = countRoots();
    await page.storage({ [LIBRARY]: { status: 'unsupported', accountId: 'reader', serverOrigin: ORIGIN } });
    await vi.waitFor(() => expect(document.body.dataset.library).toBe('unsupported'));
    expect(countRoots()).toBeGreaterThan(before);
    await page.storage({ [LIBRARY]: { status: 'ready', accountId: 'reader', serverOrigin: ORIGIN, library: page.library }, [COLLECTION]: page.library.id });
    await vi.waitFor(() => expect(document.body.dataset.library).toBe('ready'));
    const readyReads = countRoots(); page.permissionAdded();
    await vi.waitFor(() => expect(countRoots()).toBeGreaterThan(readyReads));
    await page.storage({ unrelated: true }, 'session');
    expect(document.body.dataset.library).toBe('ready');
    await page.navigate('#sync/folders');
    expect(document.body.dataset.pane).toBe('sync');
    expect(node('root-tree').textContent).toContain('Bar');
  });

  test('only trusted online input and a visible valid automation notice affect this page', async () => {
    const page = f!;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    page.online(false);
    expect(page.requests.filter(request => request.kind === 'known.connectivity.online')).toHaveLength(0);
    page.online();
    await vi.waitFor(() => expect(page.requests.filter(request => request.kind === 'known.connectivity.online')).toHaveLength(1));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    page.notice(null); page.notice({ kind: 'known.automation.notice', text: 12 });
    page.notice({ kind: 'known.automation.notice', text: 'Filed by your rule', attention: true });
    expect(document.body.textContent).toContain('Filed by your rule');
    page.notice({ kind: 'known.automation.notice', text: 'Rule completed', attention: false });
    expect(document.body.textContent).toContain('Rule completed');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    page.notice({ kind: 'known.automation.notice', text: 'Hidden notice' });
    expect(document.body.textContent).not.toContain('Hidden notice');
  });

  test('Disconnect server routes through the page auth port, resets its field and refreshes edition once', async () => {
    const page = f!;
    page.gesture('disconnect-server', 'click', false);
    expect(page.requests.filter(request => request.kind === 'known.server.disconnect')).toEqual([]);
    page.input('server-origin', ORIGIN);
    page.gesture('disconnect-server');
    await vi.waitFor(() => expect(document.body.dataset.state).toBe('signed_out'));
    await vi.waitFor(() => expect(node<HTMLInputElement>('server-origin').value).toBe(''));
    expect(page.requests.filter(request => request.kind === 'known.server.disconnect')).toEqual([
      { kind: 'known.server.disconnect', userGesture: true },
    ]);
    expect(page.http.filter(call => call === `GET ${ORIGIN}/.well-known/collection-protocol`)).toHaveLength(2);
    expect(page.nativeWrite).not.toHaveBeenCalled();
  });

  test('the page range wiring refreshes boundary/status readers only after its exact committed receipt', async () => {
    const page = f!; await page.navigate('#sync/folders');
    await vi.waitFor(() => expect(node('root-tree').textContent).toContain('Bar'));
    const beforeStatus = page.requests.filter(request => request.kind === 'known.sync.progress.get').length;
    node('save-roots').click();
    await vi.waitFor(() => expect(node('range-preview').hidden).toBe(false));
    expect(page.requests.filter(request => request.kind === 'known.roots.confirm')).toEqual([]);
    node('range-cancel').click(); expect(node('range-preview').hidden).toBe(true);
    node('save-roots').click(); await vi.waitFor(() => expect(node('range-preview').hidden).toBe(false));
    node('range-confirm').click();
    await vi.waitFor(() => expect(node('root-feedback').textContent).toBe('Folder settings saved'));
    expect(page.requests.filter(request => request.kind === 'known.roots.preview')).toEqual([
      { kind: 'known.roots.preview', viewId: 'options-roots', selectedRefs: ['bar'], privateRefs: [] },
      { kind: 'known.roots.preview', viewId: 'options-roots', selectedRefs: ['bar'], privateRefs: [] },
    ]);
    expect(page.requests.filter(request => request.kind === 'known.roots.confirm')).toEqual([
      expect.objectContaining({ previewId: 'options-range', treeDigest: 'range-tree', confirmationId: expect.any(String) }),
    ]);
    expect(page.requests.filter(request => request.kind === 'known.roots.boundaries')).toHaveLength(1);
    expect(page.requests.filter(request => request.kind === 'known.sync.progress.get').length).toBeGreaterThan(beforeStatus);
  });

  test('failed range preview and a missing committed receipt never paint settings saved or refresh manager boundaries', async () => {
    const page = f!; await page.navigate('#sync/folders');
    await vi.waitFor(() => expect(node('root-tree').textContent).toContain('Bar'));
    page.controls.rangeFailure = true; node('save-roots').click();
    await vi.waitFor(() => expect(node('root-alert').hidden).toBe(false));
    expect(node('root-alert-copy').textContent).toContain('Try again');
    expect(node('range-preview').hidden).toBe(true);
    page.controls.rangeFailure = false; page.controls.omitRangeReceipt = true; node('root-retry').click();
    await vi.waitFor(() => expect(node('root-tree').textContent).toContain('Bar')); node('save-roots').click();
    await vi.waitFor(() => expect(node('range-preview').hidden).toBe(false)); node('range-confirm').click();
    await vi.waitFor(() => expect(node('root-alert').hidden).toBe(false));
    expect(node('root-alert-copy').textContent).toContain('Try again');
    expect(node('root-feedback').textContent).not.toContain('saved');
    expect(page.requests.filter(request => request.kind === 'known.roots.boundaries')).toEqual([]);
  });
});

describe.each([
  { ...signedOut, status: 'offline' as const },
  { ...signedOut, status: 'policy_blocked' as const },
  { ...signedOut, status: 'refreshing' as const },
  { ...signedOut, status: 'connecting' as const },
  { ...signedOut, status: 'error' as const, errorCode: 'credential_revoked' },
])('options paints the $status authority state', initial => {
  beforeEach(async () => { f = await mountOptions(initial); });
  test('the status keeps the correct available recovery action', async () => {
    const page = f!;
    if (initial.status === 'connecting' || initial.status === 'refreshing') {
      expect(node<HTMLButtonElement>('primary-action').disabled).toBe(true);
      expect(node('primary-action').getAttribute('aria-busy')).toBe('true');
    } else if (initial.status === 'offline') {
      page.gesture('primary-action');
      await vi.waitFor(() => expect(document.body.dataset.state).toBe('connected'));
      expect(page.requests.filter(request => request.kind === 'known.auth.refresh')).toEqual([{ kind: 'known.auth.refresh' }]);
    } else if (initial.status === 'error') {
      page.gesture('primary-action');
      expect(node('login-panel').hidden).toBe(false);
      expect(document.activeElement).toBe(node('login-email'));
    } else {
      page.gesture('sign-out', 'click', false);
      expect(document.body.dataset.state).toBe('error');
      expect(node('status').textContent).toBe('Sign out failed');
      expect(page.requests.filter(request => request.kind === 'known.auth.logout')).toHaveLength(0);
    }
  });
});
