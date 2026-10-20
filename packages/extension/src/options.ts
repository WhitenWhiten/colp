import { createSubscriptionsShell } from './subscriptions-ui/shell.js';
import { hydrateIcons } from './icons.js';
import { bindCaptureSyncNavigation } from './capture/sync-navigation.js';
import { createOptionsRouter, type HubPane, type HubRoute } from './options-router.js';
import { createCaptureShell } from './capture/options-shell.js';
import { bindSecondarySettings } from './options-secondary-settings.js';
import type { ConnectivityRequest, ExtensionRequest, ExtensionResponse, PublicAuthState } from './types.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import { createBookmarkManager } from './bookmark-manager.js';
import { paintWelcomeSteps } from './bookmarks-welcome.js';
import { authErrorCopy } from './auth-error-copy.js';
import { refreshCloudOptions } from './cloud-capability.js';
import { parseBuildConfig, resolveRuntimeConfig } from './config.js';
import { fetchSyncEndpoints } from './manifest-client.js';
import { bindServerOriginField } from './server-origin-field.js';
import { announceAuthReason, bindLoginForm, setLoginProductLinks } from './login-form.js';
import { COLLECTION_BINDING, LIBRARY_STATE, boundLibrary, parseLibraryState } from './library.js';
import { bindPersonalSyncControls } from './personal-sync-ui.js';
import { PERSONAL_SYNC_PREFIX, parsePersonalSyncPolicy } from './personal-sync-policy.js';
import { bindFolders } from './sync-folders.js';
import { bindImport } from './sync-import.js';
import { bindFirstRunOnboarding } from './first-run-ui.js';
import { FIRST_RUN_DRAFT } from './first-run-draft.js';
import { signedInSyncStatus } from './sync-label.js';
import { bindOptionsSyncProgress } from './sync-progress-dom.js';
import { bindRangeAdjustment } from './range-ui.js';
import { bindRejoinDecisions } from './rejoin-decisions-ui.js';
import { showToast } from './toast.js';
import { createIconPolicyFact } from './icon-policy-fact.js';
import { bindOptionsCredits } from './options-credits.js';
import { bindHubChrome, bindSyncChipRefresh } from './options-hub-chrome.js';
import { bindBookmarkPreferences } from './bookmark-preferences-ui.js';
import { bindBookmarkOrganizer } from './bookmark-organizer-ui.js';
import { shortLabel } from './account-label.js';
import { createAccountView } from './options-account.js';
import { bindSelectPills, paintSelectPills } from './select-pill.js';
import { bindLogoutConfirm, openLogoutConfirm } from './logout-confirm-ui.js';
import { bindServerAccount } from './server-account-ui.js';
import { formatMoment, t } from './i18n.js';
import { bindPageLanguage, hydrateInfoTips } from './page-language.js';
import { bindAutomationsPane } from './automation/options-pane.js';

hydrateIcons(document); bindSelectPills();
const languageReady = bindPageLanguage(() => { hydrateInfoTips(); paintSelectPills(); paintWelcomeSteps(element('welcome-steps')); });

const status = element('status'); const detail = element('detail'); const action = element('primary-action') as HTMLButtonElement;
const account = element('account'); const server = element('server');
const manifest = element('manifest-state'); const session = element('session-state');
const iconPolicyFact = createIconPolicyFact(element('icon-policy'));
const welcome = element('welcome'); const dismissWelcome = element('dismiss-welcome') as HTMLButtonElement;
const rootTree = element('root-tree'); const rootFeedback = element('root-feedback');
const saveRoots = element('save-roots') as HTMLButtonElement;
const requestBookmarkPermission = element('request-bookmark-permission') as HTMLButtonElement;
const loginPanel = element('login-panel');
const accountCopy = element('account-copy'); const sessionStage = element('session-stage');
const syncConnect = element('sync-connect');
const hubChrome = bindHubChrome({ name: element('side-name'), line: element('hub-status'), dot: element('hub-dot'), signIn: element('hub-signin') });
const accountView = createAccountView();
const SYNC_VIEWS = ['folders', 'center', 'import'] as const;
const WELCOME_FLAG = 'known.onboarding.installed.v1';
const panes: Record<HubPane, HTMLElement> = {
  bookmarks: element('bookmarks-card'),
  history: element('history-card'),
  subscriptions: element('subscriptions-card'),
  sync: element('sync-card'),
  automations: element('automations-card'),
  saving: element('saving-card'),
  ai: element('ai-card'),
  general: element('general-card'),
  account: element('account-card'),
  help: element('help-card'),
};
bindCaptureSyncNavigation(panes.sync);
const automations = bindAutomationsPane(panes.automations);
// A rule filed a bookmark starred in the browser: this page says so while it is in front.
chrome.runtime.onMessage.addListener((message: unknown) => {
  const notice = message as { readonly kind?: unknown; readonly text?: unknown; readonly attention?: unknown } | null;
  if (notice?.kind === 'known.automation.notice' && typeof notice.text === 'string' && document.visibilityState === 'visible') {
    showToast(notice.text, notice.attention === true ? 'info' : 'ok', { announce: true });
  }
  return false;
});
const captureShell = createCaptureShell(document.querySelector<HTMLElement>('.main')!);
const subscriptionsShell = createSubscriptionsShell(document.querySelector<HTMLElement>('.main')!, hash => navigation.navigate(hash));
const navigation = createOptionsRouter(panes, route => {
  void captureShell.activate(route).catch(() => undefined);
  subscriptionsShell.activate(route);
  if (route.pane === 'account' && route.view === 'credits' && connected) void creditsLedger.activate();
  activatePane(route);
}, () => { captureShell.clear(); subscriptionsShell.clear(); });
const { showPane, paneFromHash } = navigation;
const bookmarkManager = createBookmarkManager({
  pane: element('bookmarks-card'),
  gate: element('manager-gate'),
  gateButton: element('manager-grant') as HTMLButtonElement,
  reloadHint: element('manager-reload-hint'),
  body: element('manager-body'),
  tree: element('manager-tree'),
  list: element('manager-list'),
  path: element('manager-path'),
  search: element('manager-search') as HTMLInputElement,
  newFolder: element('manager-new-folder') as HTMLButtonElement,
  newBookmark: element('manager-new-bookmark') as HTMLButtonElement,
  feedback: element('manager-feedback'),
  card: element('manager-card'),
  selectToggle: element('manager-select') as HTMLButtonElement,
  syncState: element('manager-sync-state'),
});
const creditsLedger = bindOptionsCredits(element('credits-card'), () => request({ kind: 'known.auth.status' }));
bindBookmarkOrganizer(async () => { if (!panes.bookmarks.hidden) await bookmarkManager.activate(); });
const bookmarkPreferences = bindBookmarkPreferences(foldersFirst => { void bookmarkManager.preferencesChanged(foldersFirst); });
let connected = false;
let serverField: Awaited<ReturnType<typeof bindServerOriginField>> | undefined;
let renderTurn = 0;
const personalSync = bindPersonalSyncControls(element('personal-sync-settings'));
const refreshEngineStatus = bindSyncChipRefresh(hubChrome, { connected: () => connected,
  read: async () => { const status = await signedInSyncStatus(); accountView.setSyncStatus(status.label); return status; },
  keys: [FIRST_RUN_DRAFT, COLLECTION_BINDING], keyPrefixes: [PERSONAL_SYNC_PREFIX] });
const syncProgress = bindOptionsSyncProgress({ connected: () => connected });
const rejoinDecisions = bindRejoinDecisions({ panel: element('rejoin-decisions'),
  show: () => showPane('sync-center'), onResolved: () => { void folders.load(); void syncProgress.refresh(); } });
const NOTICE_PANES = new Set<HubPane>(['saving', 'ai', 'subscriptions']);
const folders = bindFolders({ isConnected: () => connected, firstRun: () => firstRun,
  onRootResponse: response => rangeAdjustment.onRootResponse(response) });
const importPane = bindImport({ isConnected: () => connected,
  showStatus: () => showPane('sync-center'), showFolders: () => showPane('folders') });
let libraryNotice = '';
let libraryTurn = 0;
async function refreshLibrary(): Promise<void> {
  const turn = ++libraryTurn, authTurn = renderTurn;
  const stored = await chrome.storage.local.get([COLLECTION_BINDING, LIBRARY_STATE]);
  if (turn !== libraryTurn || authTurn !== renderTurn) return;
  const library = connected ? boundLibrary(stored, serverOrigin()) : undefined;
  document.body.dataset.library = library ? 'ready' : parseLibraryState(stored[LIBRARY_STATE])?.status === 'unsupported' ? 'unsupported' : 'unavailable';
  if (connected && document.body.dataset.library === 'unsupported') {
    const notice = serverOrigin() + ':unsupported';
    if (libraryNotice !== notice) showToast(t('auth_syncUnsupported', 'This server does not support bookmark sync yet.'), 'info');
    libraryNotice = notice;
  } else libraryNotice = '';
  firstRun.setLibraryId(library?.id);
  rangeAdjustment.setLibraryId(library?.id);
  folders.setLibraryId(library?.id);
  rejoinDecisions.setLibraryId(library?.id);
  // The library's stored title never shows: it is “your library” here as on the web.
  const libraryName = library ? t('common_yourLibraryInline', 'your library') : '';
  accountView.setCollection(libraryName);
  importPane.setCollection(libraryName);
}
chrome.storage.onChanged.addListener((changes, area) => {
  const resumed = Object.entries(changes).some(([key, change]) => key.startsWith(PERSONAL_SYNC_PREFIX)
    && parsePersonalSyncPolicy(change.newValue).mode === 'enabled');
  if (area === 'local' && (COLLECTION_BINDING in changes || LIBRARY_STATE in changes || resumed)) {
    void refreshLibrary().then(() => { if (connected) void folders.load(); });
  }
});

action.addEventListener('click', (event) => { void act(event.isTrusted && navigator.userActivation.isActive); });
bindLogoutConfirm({
  busy,
  render,
  requestLogout: () => request({ kind: 'known.auth.logout', userGesture: true }),
});
const loginForm = bindLoginForm({
  async signInPassword(email, password) {
    await completeLogin({ kind: 'known.auth.login', userGesture: true, method: 'password', email, password });
  },
  async sendOtp(email) {
    await serverField?.ready();
    const response = await request({ kind: 'known.auth.send-otp', userGesture: true, email });
    if (!response.ok) throw new Error(response.state.errorCode ?? response.error);
  },
  async signInOtp(email, otp) {
    await completeLogin({ kind: 'known.auth.login', userGesture: true, method: 'otp', email, otp });
  },
  async startOAuth(provider) {
    await completeLogin({ kind: 'known.auth.login', userGesture: true, method: 'oauth', provider });
  },
});
paintWelcomeSteps(element('welcome-steps'));
dismissWelcome.addEventListener('click', event => { if (event.isTrusted) void dismissWelcomeMessage(); });
element('welcome-import').addEventListener('click', () => { element('manager-import').click(); });
element('sign-out').addEventListener('click', (event) => { void act(event.isTrusted && navigator.userActivation.isActive, 'logout'); });
element('side-version').textContent = t('shell_version', 'Know-N $1', chrome.runtime.getManifest?.().version ?? '');
chrome.permissions.onAdded?.addListener?.(() => { if (connected) void folders.load(); });
const rangeAdjustment = bindRangeAdjustment({ saveRoots, rootTree, rootFeedback,
  getView: () => folders.view(), setView: (view) => { folders.render(view); },
  reloadBoundaries: () => { void bookmarkManager.reloadBoundaries(); },
  onConfirmed: () => { void syncProgress.refresh({ showDone: true }); void refreshEngineStatus(); },
  isConnected: () => connected, renderFailure: (code) => { folders.renderFailure(code); } });
saveRoots.addEventListener('click', () => { void rangeAdjustment.save(); });
self.addEventListener('online', (event) => {
  if (event.isTrusted && navigator.onLine === true) void chrome.runtime.sendMessage({ kind: 'known.connectivity.online' } satisfies ConnectivityRequest).catch(() => undefined);
});
const firstRun = bindFirstRunOnboarding({ rootTree, saveRoots, requestPermission: requestBookmarkPermission,
  folderHeading: element('folder-heading'), folderIntro: element('folder-intro'),
  serverLabel: () => { try { return new URL(serverOrigin()).host; } catch { return serverOrigin(); } }, showPane,
  onSyncStatusChanged: () => {
    void syncProgress.refresh(); void refreshEngineStatus(); void personalSync.refresh();
    queueMicrotask(() => { if (!firstRun.isRangeActive()) void folders.load(); });
  } });
bindSecondarySettings();
const serverAccount = bindServerAccount({
  busy,
  render,
  requestDisconnect: () => request({ kind: 'known.server.disconnect', userGesture: true }),
});
void initialize();

async function act(hasUserGesture: boolean, forced?: 'logout'): Promise<void> {
  const kind = forced ?? action.dataset.action;
  if ((kind === 'logout') && !hasUserGesture) {
    render({ ok: false, error: 'logout_gesture_required', state: { status: 'error',
      environment: 'production', serverOrigin: server.textContent && server.textContent !== t('common_unavailable', 'Unavailable') ? server.textContent : '',
      errorCode: 'logout_gesture_required' } });
    return;
  }
  if (kind === 'login') {
    loginPanel.hidden = false;
    sessionStage.hidden = true;
    element('login-email').focus();
    return;
  }
  if (kind === 'logout') {
    openLogoutConfirm();
    return;
  }
  const message: ExtensionRequest = { kind: 'known.auth.refresh' };
  busy(kind === 'retry' ? t('common_retrying', 'Retrying…') : t('common_refreshing', 'Refreshing…'));
  render(await request(message));
}
async function request(message: ExtensionRequest): Promise<ExtensionResponse> {
  try { return await chrome.runtime.sendMessage(message) as ExtensionResponse; }
  catch { return { ok: false, error: 'extension_unavailable', state: { status: 'error', environment: 'production', serverOrigin: '', errorCode: 'extension_unavailable' } }; }
}
async function completeLogin(message: Extract<ExtensionRequest, { kind: 'known.auth.login' }>): Promise<void> {
  await serverField?.ready();
  welcome.hidden = true;
  await chrome.storage.local.remove(WELCOME_FLAG);
  busy(t('common_signingIn', 'Signing in…'));
  const response = await request(message);
  render(response);
  if (response.state.status === 'connected' && paneFromHash() === 'account' && !navigation.current().params.has('return')) firstRun.onSignedIn(true,
    isProtocolOpaqueId((await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING]));
  if (response.state.status === 'connected') navigation.returnAfterLogin();
  if (response.state.status !== 'connected') {
    throw new Error(response.state.errorCode ?? (response.ok ? 'authentication_failed' : response.error));
  }
}
function render(response: ExtensionResponse): void {
  const turn = ++renderTurn;
  const state = response.state; document.body.dataset.state = state.status; action.disabled = false; action.removeAttribute('aria-busy');
  server.textContent = state.serverOrigin || t('common_unavailable', 'Unavailable');
  serverAccount.refresh(state.serverOrigin);
  const brandLink = document.getElementById('brand-link') as HTMLAnchorElement | null;
  if (brandLink && state.serverOrigin) brandLink.href = state.serverOrigin;
  account.textContent = state.accountLabel ?? (state.status === 'connected' ? t('common_signedIn', 'Signed in') : t('sync_notSignedIn', 'Not signed in'));
  accountView.paintIdentity(state);
  manifest.textContent = state.status === 'connected' ? t('common_verified', 'Verified') : t('icons_notConnected', 'Not connected');
  session.textContent = state.sessionExpiresAt ? t('options_activeUntil', 'Active until $1', formatTime(state.sessionExpiresAt)) : t('options_noActiveSession', 'No active session');
  iconPolicyFact.refresh(state.status === 'connected');
  accountView.paintAlert(copy(state), state.status !== 'connected' && state.status !== 'signed_out', state.status === 'connecting' || state.status === 'refreshing');
  connected = state.status === 'connected';
  const signedInView = state.status === 'connected' || state.status === 'refreshing' || state.status === 'connecting'
    || Boolean(state.accountLabel);
  loginPanel.hidden = signedInView;
  // Signed out, the session detail is hidden, so the reason toasts like on the web.
  if (!signedInView) announceAuthReason(state);
  sessionStage.hidden = !signedInView; accountCopy.hidden = signedInView;
  navigation.setPaneViews('account', signedInView ? ['session', 'credits'] : ['session']);
  void refreshCloudOptions(state.serverOrigin, {
    signedIn: signedInView,
    navigate: (hash) => navigation.navigate(hash),
    setAccountViews: (views) => navigation.setPaneViews('account', views),
    setLoginCloud: cloud => loginForm.setCloudEnabled(cloud),
    isCurrent: () => turn === renderTurn,
  });
  syncConnect.hidden = connected; navigation.setPaneViews('sync', connected ? SYNC_VIEWS : []);
  if (signedInView) welcome.hidden = true;
  setLoginProductLinks(state.serverOrigin);
  hubChrome.setAccount(state.status, state.accountLabel && shortLabel(state.accountLabel)); void refreshLibrary();
  if (connected && navigation.currentView('account') === 'credits') void creditsLedger.activate();
  refreshCreditsSummary();
  if (connected) void refreshEngineStatus();
  void syncProgress.refresh();
  rangeAdjustment.onConnection(connected); folders.onConnection(connected); importPane.onConnection(connected);
  rejoinDecisions.onConnection(connected);
  void personalSync.refresh();
  void bookmarkPreferences.refresh(); void navigation.refreshIdentity();
}
async function initialize(): Promise<void> {
  await languageReady;
  serverField = await bindServerOriginField({
    async validate(origin) {
      const build = await fetch(chrome.runtime.getURL('generated-config.json')).then(response => response.json()).then(parseBuildConfig);
      await fetchSyncEndpoints(resolveRuntimeConfig(build, origin));
    },
    async disconnect(nextOrigin) {
      const response = await request({ kind: 'known.server.disconnect', userGesture: true, ...(nextOrigin ? { nextOrigin } : {}) });
      if (!response.ok) throw new Error(response.error);
    },
    async refresh() { render(await request({ kind: 'known.auth.status' })); },
  });
  await navigation.initialize();
  await request({ kind: 'known.auth.status' }).then(render);
  const value = (await chrome.storage.local.get(WELCOME_FLAG))[WELCOME_FLAG];
  welcome.hidden = !(value === 'installed' && !connected); if (!welcome.hidden && !navigation.explicitAtOpen) navigation.navigate('#bookmarks', true);
  await chrome.storage.local.remove(WELCOME_FLAG);
  if (!navigation.explicitAtOpen) firstRun.onSignedIn(connected, isProtocolOpaqueId((await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING]));
}
async function dismissWelcomeMessage(): Promise<void> { welcome.hidden = true; await chrome.storage.local.remove(WELCOME_FLAG); }
function serverOrigin(): string {
  const value = server.textContent;
  return value && value !== t('icons_checking', 'Checking') && value !== t('common_unavailable', 'Unavailable') ? value : 'https://know-n.com';
}
function copy(state: PublicAuthState): { title: string; detail: string; action: string; actionKind: string } {
  switch (state.status) {
    case 'connected': return { title: t('common_signedIn', 'Signed in'), detail: t('options_youreSignedBrowser', "You're signed in on this browser."), action: t('common_signOut', 'Sign out'), actionKind: 'logout' };
    case 'offline': return { title: t('common_offline', 'Offline'), detail: t('auth_checkConnectionTryAgain', 'Check your connection and try again.'), action: t('common_retry', 'Retry'), actionKind: 'retry' };
    case 'policy_blocked': return { title: t('common_signInBlocked', 'Sign-in blocked'), detail: t('auth_browserPolicyDoesNot', 'Your browser policy does not allow this sign-in.'), action: t('common_signOut', 'Sign out'), actionKind: 'logout' };
    case 'refreshing': return { title: t('common_refreshingConnection', 'Refreshing connection'), detail: t('options_renewingSecureSession', 'Renewing your secure session.'), action: t('common_refreshing', 'Refreshing…'), actionKind: 'refresh' };
    case 'connecting': return { title: t('common_connecting', 'Connecting'), detail: t('options_completingSecureSign', 'Completing secure sign-in.'), action: t('common_connecting2', 'Connecting…'), actionKind: 'login' };
    case 'error': {
      if (state.errorCode === 'logout_gesture_required') {
        return { title: t('options_signOutFailed', 'Sign out failed'), detail: authErrorCopy(state.errorCode), action: t('common_signOut', 'Sign out'), actionKind: 'logout' };
      }
      const needsReauth = state.errorCode === 'credential_revoked' || state.errorCode === 'invalid_grant' || state.errorCode === 'authentication_required';
      return { title: t('common_signInProblem', 'Sign-in problem'), detail: authErrorCopy(state.errorCode), action: needsReauth ? t('options_signInAgain', 'Sign in again') : t('common_retry', 'Retry'), actionKind: needsReauth ? 'login' : 'retry' };
    }
    default: return { title: t('icons_notConnected', 'Not connected'), detail: t('options_signThenChooseWhere', 'Sign in, then choose where this browser syncs.'), action: t('common_signIn', 'Sign in'), actionKind: 'login' };
  }
}
function busy(label: string): void {
  accountView.paintAlert({ title: label, detail: t('common_pleaseWait', 'Please wait.'), action: label, actionKind: action.dataset.action ?? 'refresh' }, true, true);
}
function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error('options_markup_invalid'); return value; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? t('common_unknownTime', 'unknown time') : formatMoment(date); }

/** The Account page's balance row; read when the page opens and when the connection changes. */
function refreshCreditsSummary(): void {
  if (connected && document.body.dataset.pane === 'account') void accountView.loadCredits(() => creditsLedger.loadOverview());
}
function activatePane(route: HubRoute): void {
  // Preference conflict resolution is kept at the end of the pane so headers never jump; status toasts in the bottom-right.
  if (NOTICE_PANES.has(route.pane)) panes[route.pane].append(element('bookmark-preferences-notice'));
  if (route.pane === 'account') refreshCreditsSummary();
  /* R13 D-21: the popup deep-links #folders?native=<folderId>; hand it to
     the next roots.get so the worker can mark that row preselected. */
  if (route.pane === 'sync' && route.view === 'folders') folders.setPreselect(route.params.get('native') ?? undefined);
  if (route.pane === 'sync' && connected) {
    void refreshLibrary(); void folders.load(); void personalSync.refresh(); void rejoinDecisions.refresh();
  }
  if (route.pane === 'bookmarks') void bookmarkManager.activate(); else bookmarkManager.deactivate();
  if (route.pane === 'automations') automations.activate(); else automations.deactivate();
}
