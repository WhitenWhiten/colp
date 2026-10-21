import { showAutomationBadge } from '../action-badge.js';
import { logBackgroundFailure } from './background-failure.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { PersonalSyncStopped } from '../personal-sync-policy.js';
import { suspendPersonalSyncForLogout } from './personal-sync.js';
import { ensureLibraryBinding, libraryUnsupported, bindLibraryOnStartup } from './library.js';
import { LIBRARY_STATE } from '../library.js';
import { prepareSubscriptionLogout, maintenance as subscriptionMaintenance, wakeSubscriptions } from '../bookmark-subscriptions/runtime.js';
import type { AuthorityContext } from '../authority-fence.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { clearSaveContextCache } from '../save-context-cache.js';
import type { AuthExtensionRequest, ExtensionResponse, StoredCredential } from '../types.js';
import { scheduleSyncEngineWake } from './engine.js';
import { clearAccountAutomation } from './automation.js';
import { COLLECTION_BINDING, WELCOME_FLAG, safeError, store, sw, syncState, workCoordinator } from './runtime.js';
import { createRuntimeAuth, currentSyncScope, enforceManagedPolicy, ensureSyncScope, hasBoundCollection,
  loadConfig, pushSessionAuthority, retire, scheduleSessionFreshen, stateAfterFailure } from './scope.js';

export async function onExtensionInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  await showAutomationBadge({ title: false });
  if (details.reason !== 'install') return;
  await Promise.allSettled([
    chrome.storage.local.set({ [WELCOME_FLAG]: 'installed' }),
    chrome.runtime.openOptionsPage(),
  ]);
}

export async function handle(message: AuthExtensionRequest, context: AuthorityContext): Promise<ExtensionResponse> {
  const config = await loadConfig();
  await enforceManagedPolicy(config, message.kind);
  const endpoints = async () => fetchSyncEndpoints(config);
  const auth = createRuntimeAuth(config, async (credential, session, signal) => retire(await endpoints(), credential, session, signal));
  if (message.kind === 'known.auth.status') {
    // Status answers from local storage only: the popup's first frame must
    // never wait on a token refresh or a COLP session mint. Freshening runs
    // after this response, serialized behind the same authority queue.
    const initial = await auth.status();
    if (initial.status === 'connected') {
      if (await hasBoundCollection()) scheduleSessionFreshen();
      else void bindLibraryOnStartup().catch((error) => logBackgroundFailure('auth.bind-library', error));
    }
    return { ok: true, state: await libraryUnsupported() ? { ...initial, errorCode: 'sync_unsupported' } : initial };
  }
  if (message.kind === 'known.auth.refresh') {
    if (!await hasBoundCollection()) {
      await ensureLibraryBinding({ authLane: true });
      if (!await hasBoundCollection()) return { ok: true, state: { ...await auth.status(), ...(await libraryUnsupported() ? { errorCode: 'sync_unsupported' } : {}) } };
    }
    await pushSessionAuthority(true);
    await scheduleSyncEngineWakeIfRootConfigured();
    return { ok: true, state: await auth.status() };
  }
  if (message.kind === 'known.auth.logout') {
    if (configuredPersonalSyncPolicy()) await suspendPersonalSyncForLogout();
    const credential = await store.loadCredential();
    if (credential?.subject) await prepareSubscriptionLogout(credential.subject, credential.serverOrigin);
    const binding = await store.loadBinding();
    sw.bookmarkEventQueue = undefined;
    sw.bookmarkEventScopeKey = undefined;
    let signedOut = false;
    try {
      const state = await auth.logout();
      signedOut = true;
      // This handler itself is the active auth-lane task. Waiting on every
      // lane here would include the current promise and deadlock forever.
      await workCoordinator.drain('auth');
      return { ok: true, state };
    } finally {
      sw.bindingPromise = undefined; sw.rootViewTokens = undefined;
      if (typeof globalThis.chrome?.storage?.local?.remove === 'function') await chrome.storage.local.remove([COLLECTION_BINDING, LIBRARY_STATE]);
      await clearSaveContextCache().catch((error) => logBackgroundFailure('auth.clear-save-context', error));
      if (credential?.subject && signedOut) {
        // Re-clear in case a concurrent engine write restored the credential
        // between auth.logout() clearing it and this cleanup.
        await store.clearAuthority();
        await subscriptionMaintenance.cleanup();
        if (binding) await syncState.cleanupAccount({ environment: config.environment,
          serverId: config.serverOrigin, accountId: credential.subject, browserProfileId: binding.browserProfileId });
        // The account's automation data goes with it; this browser's own rules stay (AW-72).
        await clearAccountAutomation({ serverOrigin: credential.serverOrigin, accountId: credential.subject })
          .catch((error) => logBackgroundFailure('auth.clear-account-automation', error));
      }
    }
  }
  if (message.kind === 'known.auth.send-otp') {
    try {
      await auth.sendOtp(message.email);
      return { ok: true, state: await auth.status() };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'otp_send_failed';
      return { ok: false, state: { status: 'signed_out', environment: config.environment,
        serverOrigin: config.serverOrigin, errorCode: code }, error: code };
    }
  }
  if (message.kind !== 'known.auth.login') throw new Error('request_invalid');
  const previous = await store.loadCredential();
  if (previous?.subject && configuredPersonalSyncPolicy()) await suspendPersonalSyncForLogout();
  if (previous?.subject) await prepareSubscriptionLogout(previous.subject, previous.serverOrigin);
  const login = await auth.login(message);
  void wakeSubscriptions('startup');
  if (login.status !== 'connected') return { ok: false, state: login, error: login.errorCode ?? 'authentication_failed' };
  const credential: StoredCredential = await auth.ensureFreshCredential();
  if (previous?.subject && (previous.subject !== credential.subject || previous.serverOrigin !== credential.serverOrigin)) {
    if (typeof globalThis.chrome?.storage?.local?.remove === 'function') await chrome.storage.local.remove([COLLECTION_BINDING, LIBRARY_STATE]);
    if (configuredPersonalSyncPolicy()) { await store.clearBinding(); sw.bindingPromise = undefined; }
  }
  // Signing in as someone else is a sign-out for the earlier account's automation data too (AW-72).
  if (previous?.subject && (previous.subject !== credential.subject || previous.serverOrigin !== credential.serverOrigin)) {
    await clearAccountAutomation({ serverOrigin: previous.serverOrigin, accountId: previous.subject })
      .catch((error) => logBackgroundFailure('auth.clear-previous-account-automation', error));
  }
  try { await ensureLibraryBinding({ login: true }); } catch { /* Sign-in stays usable when library discovery is temporarily offline. */ }
  if (!await hasBoundCollection()) return { ok: true, state: { ...await auth.status(), ...(await libraryUnsupported() ? { errorCode: 'sync_unsupported' } : {}) } };
  try {
    // A login changes the credential authority, so the Session lane mints: it
    // compares the stored Session's credential authority digest with the one
    // just authenticated, which also covers a login that switched accounts.
    // Minting here directly (and clearing the stored Session first) was a third
    // unserialized decision point, and the duplicate Session it produced
    // invalidated whatever Snapshot/Ack the engine already had in flight.
    const authority = await pushSessionAuthority();
    // The generation comes from the LIVE fence, not from `context`: this message
    // activated a new authority generation when it logged in (auth-controller
    // `persistSession` -> `activateAuthority`), so the generation the handler was
    // invoked under is stale by now. Passing it made `ensureSyncScope` throw
    // `AuthorityFencedError`. Clearing the Session on that failure minted,
    // discarded, and minted again, and the scope import never happened. Leave
    // the minted Session in place; report the failure instead of success.
    const live = await store.fence.capture();
    await ensureSyncScope(config, authority.credential, authority.session, live.generation);
    await scheduleSyncEngineWakeIfRootConfigured();
    return { ok: true, state: await auth.status() };
  } catch (error) {
    // A user pause refuses the Session lane before any mint. Sign-in still
    // succeeded; the pause itself stays, and no Session is cleared or minted.
    if (error instanceof PersonalSyncStopped) return { ok: true, state: await auth.status() };
    // The message channel already answers a thrown auth error as
    // `{ ok: false, state, error }`. Swallowing it here used to report success.
    return { ok: false, state: await stateAfterFailure(error), error: safeError(error) };
  }
}

async function scheduleSyncEngineWakeIfRootConfigured() {
  if (!await hasBoundCollection()) return;
  try {
    const scope = await currentSyncScope();
    if (await syncState.getScope(scope)) scheduleSyncEngineWake('manual');
  } catch { /* Bound collection without a live scope cannot start the engine. */ }
}
