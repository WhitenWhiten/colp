import { releaseMetadataBindings } from '../metadata-transfer.js';
import { browserMetadataSyncPolicy } from '../metadata-sync-policy.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { suspendPersonalSyncForLogout } from './personal-sync.js';
import { boundCollectionId } from './scope.js';
import { verifyCollectionAvailability } from './collections.js';
import { prepareSubscriptionLogout, maintenance as subscriptionMaintenance, wakeSubscriptions } from '../bookmark-subscriptions/runtime.js';
import type { AuthorityContext } from '../authority-fence.js';
import { clearCollectionsCache } from '../collections-cache.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { isProtocolOpaqueId } from '../protocol-id.js';
import { clearSaveContextCache } from '../save-context-cache.js';
import { sessionMatchesCredentialAuthority, syncSessionNeedsRenewal } from '../session-client.js';
import type { AuthExtensionRequest, ExtensionResponse, StoredCredential } from '../types.js';
import { scheduleSyncEngineWake } from './engine.js';
import { COLLECTION_BINDING, WELCOME_FLAG, store, sw, syncState, workCoordinator } from './runtime.js';
import { createRuntimeAuth, currentSyncScope, enforceManagedPolicy, ensureSyncScope, hasBoundCollection,
  loadConfig, pushSessionAuthority, retire, scheduleSessionFreshen } from './scope.js';

export async function onExtensionInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  // Earlier builds pinned a "Set up" badge on install that only cleared on
  // collection select, so it lingered on the toolbar icon indefinitely. The
  // badge is gone; wipe any leftover text so upgraded profiles lose it too.
  await chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
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
  if (message.kind === 'known.collection.select') {
    if (!message.userGesture || !isProtocolOpaqueId(message.collectionId)) throw new Error('collection_invalid');
    const selectedCredential = await store.loadCredential();
    if (!selectedCredential?.subject) throw new Error('authentication_required');
    const metadataScope = { serverOrigin: selectedCredential.serverOrigin,
      accountId: selectedCredential.subject, collectionId: message.collectionId };
    const personal = configuredPersonalSyncPolicy();
    const prior = await boundCollectionId();
    if (personal) {
      if (prior && prior !== message.collectionId) throw new Error('personal_sync_disconnect_required');
    }
    // Refusing metadata for the existing target is an entirely local action.
    // Persist it before any network work, including session refresh or discovery.
    if (prior === message.collectionId && !message.migrateMetadata) {
      await browserMetadataSyncPolicy().write(metadataScope, false);
      return { ok: true, state: await auth.status() };
    }
    if (personal) {
      if (await verifyCollectionAvailability(metadataScope) !== 'available') throw new Error('personal_sync_target_unverified');
      if (!prior) await personal.write(metadataScope, 'enabled');
    }
    // A negative choice must exist before the new binding becomes observable.
    // Keep the gate closed during a positive transfer as well; failure stays local.
    await browserMetadataSyncPolicy().write(metadataScope, false);
    await chrome.storage.local.set({ [COLLECTION_BINDING]: message.collectionId });
    if (message.migrateMetadata) {
      // Changing the selection fences the old engine's target checks. Do not drain
      // a lane that may be waiting for this auth lane to refresh its session.
      await workCoordinator.run('local-bookmark', () => releaseMetadataBindings());
      await browserMetadataSyncPolicy().write(metadataScope, true);
    }
    // The mint below goes through the serialized Session lane, and the stored
    // Session is deliberately NOT cleared first. Clearing it was a second,
    // unserialized decision point: any concurrent flow that read the stored
    // Session in that window saw "no Session" and minted too, and the second
    // mint advanced the Replica's lifecycle revision, denying the first flow's
    // in-flight Ack as `stale_replica` (measured in
    // e2e/mv3-first-run-remediation.spec.ts). The lane decides on the Session it
    // finds — including one bound to a different Collection — and `saveSession`
    // replaces it.
    const credential = await store.loadCredential();
    if (credential) {
      // Selecting the already-bound collection must not tear down a healthy
      // session. The save popup does not select a collection.
      const existing = await store.loadSession();
      const reusable = existing !== null && existing.collection.collectionId === message.collectionId
        && !syncSessionNeedsRenewal(existing) && await sessionMatchesCredentialAuthority(existing, credential);
      if (!reusable) {
        try {
          const authority = await pushSessionAuthority();
          await ensureSyncScope(config, authority.credential, authority.session, context.generation);
        } catch {
          // Selection is a local binding. If the session mint fails here
          // (network, cookie, rate limit), keep the binding — requireSyncScope
          // and auth.status mint the session lazily on the next request.
        }
      }
      await scheduleSyncEngineWakeIfRootConfigured();
    }
    return { ok: true, state: await auth.status() };
  }
  if (message.kind === 'known.auth.status') {
    // Status answers from local storage only: the popup's first frame must
    // never wait on a token refresh or a COLP session mint. Freshening runs
    // after this response, serialized behind the same authority queue.
    const initial = await auth.status();
    if (initial.status === 'connected' && await hasBoundCollection()) scheduleSessionFreshen();
    return { ok: true, state: initial };
  }
  if (message.kind === 'known.auth.refresh') {
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
      await clearCollectionsCache();
      if (typeof globalThis.chrome?.storage?.local?.remove === 'function') await chrome.storage.local.remove(COLLECTION_BINDING);
      await clearSaveContextCache().catch(() => undefined);
      if (credential?.subject && signedOut) {
        // Re-clear in case a concurrent engine write restored the credential
        // between auth.logout() clearing it and this cleanup.
        await store.clearAuthority();
        await subscriptionMaintenance.cleanup();
        if (binding) await syncState.cleanupAccount({ environment: config.environment,
          serverId: config.serverOrigin, accountId: credential.subject, browserProfileId: binding.browserProfileId });
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
  if (previous?.subject && previous.subject !== credential.subject) {
    if (typeof globalThis.chrome?.storage?.local?.remove === 'function') await chrome.storage.local.remove(COLLECTION_BINDING);
    if (configuredPersonalSyncPolicy()) { await store.clearBinding(); sw.bindingPromise = undefined; }
  }
  if (!await hasBoundCollection()) return { ok: true, state: await auth.status() };
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
    // `AuthorityFencedError`, and the catch below then deleted the Session the
    // lane had just minted — every login minted, discarded, and minted again, and
    // the scope import never happened.
    const live = await store.fence.capture();
    try { await ensureSyncScope(config, authority.credential, authority.session, live.generation); }
    catch { await store.clearSession(); }
    await scheduleSyncEngineWakeIfRootConfigured();
    return { ok: true, state: await auth.status() };
  } catch {
    return { ok: true, state: await auth.status() };
  }
}

async function scheduleSyncEngineWakeIfRootConfigured() {
  if (!await hasBoundCollection()) return;
  try {
    const scope = await currentSyncScope();
    if (await syncState.getScope(scope)) scheduleSyncEngineWake('manual');
  } catch { /* Bound collection without a live scope cannot start the engine. */ }
}
