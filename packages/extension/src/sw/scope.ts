import { AuthorityFencedError, type AuthorityContext } from '../authority-fence.js';
import { createAuthController } from '../auth-controller.js';
import { colpCredentialHeaders } from '../auth-client.js';
import { parseBuildConfig, resolveRuntimeConfig, RUNTIME_ORIGIN_KEY } from '../config.js';
import { assertCredentialHostPermission, credentialGatedFetch } from '../server-origin-permission.js';
import { enforceManagedConfiguration, managedServerOrigin } from '../managed-policy.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { declaredClientTransportBudget, SYNC_TRANSPORT_BUDGET_EXTENSION } from '../colp-transport-budget-browser.js';
import { isProtocolOpaqueId } from '../protocol-id.js';
import { createSyncSession, retainSessionAfterTransientRenewalFailure, retryStaleReplicaSession,
  SessionRequestError,
  sessionMatchesCredentialAuthority, shouldForceSessionRefresh, syncSessionNeedsRenewal } from '../session-client.js';
import type { SyncScope } from '../sync-state-store.js';
import type { BuildConfig, ExtensionRequest, StoredAuthBinding, StoredCredential, StoredSession } from '../types.js';
import { resolveSessionBootstrapMode, resolveSessionMountBinding, retireScopeIfQueueDrained } from '../session-binding.js';
import { COLLECTION_BINDING, extensionOrigin, safeError, store, sw, syncState, workCoordinator } from './runtime.js';
import { writeAuthSnapshot } from '../auth-snapshot.js';
import { configuredPersonalSyncPolicy, personalSyncFetch } from '../personal-sync-fetch.js';
import { lastKnownClientClockSkew, localTimeOf, rememberClientClockSkew } from '../session-clock.js';
import { recordClockSkew } from '../session-clock-record.js';

export async function loadConfig(): Promise<BuildConfig> {
  sw.configPromise ??= fetch(chrome.runtime.getURL('generated-config.json'), { cache: 'no-store' })
    .then((response) => { if (!response.ok) throw new Error('configuration_unavailable'); return response.json(); })
    .then(parseBuildConfig);
  const build = await sw.configPromise;
  try {
    const managed = await chrome.storage.managed.get(['identityDisabled', 'serverOrigin']);
    const managedOrigin = managedServerOrigin(managed);
    if (managedOrigin) return resolveRuntimeConfig(build, managedOrigin);
  } catch { /* managed storage is absent outside enterprise policy */ }
  try {
    const stored = await chrome.storage.local.get(RUNTIME_ORIGIN_KEY);
    const value = stored[RUNTIME_ORIGIN_KEY];
    if (typeof value === 'string' && value.length > 0) return resolveRuntimeConfig(build, value);
  } catch { /* storage unavailable; keep the pinned build */ }
  // e2e-fixture builds only. The file is absent in store builds; parseBuildConfig cannot pin plain HTTP.
  if (build.deploymentId === 'e2e-fixture') {
    const override = await readPackagedJson('e2e-origin.json');
    const origin = override && typeof override === 'object' ? (override as { origin?: unknown }).origin : undefined;
    if (typeof origin === 'string' && origin.length > 0) return resolveRuntimeConfig(build, origin);
  }
  return build;
}

export function createRuntimeAuth(
  config: BuildConfig,
  retireSession?: (credential: StoredCredential, session: StoredSession, signal?: AbortSignal) => Promise<void>,
) {
  return createAuthController({
    config,
    store,
    origin: `chrome-extension://${chrome.runtime.id}`,
    cookies: chrome.cookies,
    openOAuthTab: (url) => chrome.tabs.create({ url }),
    fetch: evidenceTransportFetch,
    // The credential's expiry is server time too (W2B-P0-1): judge it with the skew the last Session measured.
    now: () => Date.now() - lastKnownClientClockSkew(),
    ...(retireSession ? { retire: retireSession } : {}),
    drain: () => workCoordinator.drain('auth'),
  });
}

async function readPackagedJson(name: string): Promise<unknown> {
  try {
    const response = await fetch(`${chrome.runtime.getURL(name)}?e2e=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return undefined;
    return await response.json();
  } catch { return undefined; }
}

async function evidenceTransportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Managed and saved origins both arrive through loadConfig. Neither may receive a password or cookie
  // until this install already has that host, including a host declared in the build manifest.
  await assertCredentialHostPermission(input, init);
  if (typeof __KNOWN_EXTENSION_EVIDENCE__ !== 'undefined' && __KNOWN_EXTENSION_EVIDENCE__) {
    const fault = await readPackagedJson('e2e-fault.json');
    const mode = fault && typeof fault === 'object' ? (fault as { mode?: unknown }).mode : undefined;
    if (mode === 'offline') throw new TypeError('Failed to fetch');
  }
  return fetch(input, init);
}

export async function enforceManagedPolicy(config: BuildConfig, action: ExtensionRequest['kind']): Promise<void> {
  if (action === 'known.auth.logout') return;
  let managed: Record<string, unknown> = {};
  try { managed = await chrome.storage.managed.get(['identityDisabled', 'serverOrigin']); } catch { return; }
  enforceManagedConfiguration(managed, config);
}

export async function retire(endpoints: Awaited<ReturnType<typeof fetchSyncEndpoints>>, credential: StoredCredential,
  session: StoredSession, signal?: AbortSignal): Promise<void> {
  const init: RequestInit = { method: 'DELETE', redirect: 'error', credentials: 'omit', headers: {
    ...colpCredentialHeaders(credential.accessToken), Origin: extensionOrigin(),
    'Known-Sync-Session': session.sessionId, 'Idempotency-Key': crypto.randomUUID() }, signal };
  await assertCredentialHostPermission(endpoints.syncRetire, init);
  const response = await fetch(endpoints.syncRetire, init);
  if (response.status !== 204) throw new Error('retire_failed');
}

/** The bound Collection id, or null when the binding is absent or malformed. */
export async function boundCollectionId(): Promise<string | null> {
  const collectionValue = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
  return isProtocolOpaqueId(collectionValue) ? collectionValue : null;
}

export async function hasBoundCollection(): Promise<boolean> {
  return await boundCollectionId() !== null;
}

export async function sessionRequest(expectedGeneration: number, maxBatchOperations = 1) {
  const binding = await bindingForRequest(expectedGeneration);
  const config = await loadConfig(); const credential = await store.loadCredential();
  const collectionValue = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
  if (!isProtocolOpaqueId(collectionValue)) throw new Error('collection_required');
  const identity = credential?.subject ? {
    environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: credential.subject, browserProfileId: binding.browserProfileId, collectionId: collectionValue,
    replicaId: binding.replicaId, generation: Number(binding.generation),
  } : null;
  const local = identity ? await syncState.getScope(identity) : null;
  const legacyColp = local?.legacyCanonicalRoot ?? local?.selectedRoots[0];
  const legacyNativeId = identity && legacyColp
    ? (await syncState.getMappingByColpId(identity, legacyColp))?.nativeId ?? null : null;
  const replicaBinding = resolveSessionMountBinding({
    browserProfileId: binding.browserProfileId, generation: binding.generation, scope: local, legacyNativeId,
  });
  const bootstrapMode = identity ? await syncState.currentBootstrapMode(identity) : 'merge';
  return { protocolVersion: '0.2', replica: { replicaId: binding.replicaId, name: 'Chromium', kind: 'browser_extension',
    adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true,
      events: true, separator: false, alias: false, annotations: 'sidecar', maxBatchOperations },
    binding: replicaBinding,
    extensions: { [SYNC_TRANSPORT_BUDGET_EXTENSION]: declaredClientTransportBudget() } },
    scope: 'collection', collection: { collectionId: collectionValue, lastCursor: local?.checkpoint?.cursor ?? null,
      lastRevision: local?.checkpoint?.serverRevision ?? null,
      bootstrapMode: resolveSessionBootstrapMode(bootstrapMode) }, clientTime: new Date().toISOString() };
}

export async function ensureSyncScope(config: BuildConfig, credential: StoredCredential, session: StoredSession,
  expectedGeneration: number): Promise<SyncScope> {
  await store.assertWritable(expectedGeneration);
  if (!credential.subject) throw new Error('account_identity_missing');
  const binding = await bindingForRequest(expectedGeneration);
  const scope: SyncScope = { environment: config.environment, serverId: config.serverOrigin,
    serverOrigin: config.serverOrigin, accountId: credential.subject, browserProfileId: binding.browserProfileId,
    collectionId: session.collection.collectionId, replicaId: binding.replicaId, generation: Number(binding.generation) };
  await syncState.importPreformalBinding({ schemaVersion: 0, source: 'p3-27-chrome-storage-binding',
    environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: credential.subject, browserProfileId: binding.browserProfileId,
    collectionId: session.collection.collectionId, replicaId: binding.replicaId, generation: Number(binding.generation),
    leaseId: session.replicaLease.leaseId, leaseExpiresAt: Date.parse(session.replicaLease.expiresAt),
    leaseGeneration: session.replicaLease.generation,
    checkpoint: { serverRevision: session.collection.serverRevision, serverCursor: session.collection.serverCursor } });
  try { await store.assertWritable(expectedGeneration); }
  catch (error) {
    if (error instanceof AuthorityFencedError) {
      await syncState.retireScope(scope, { retiredAt: Date.now(), reason: 'authority_fenced' });
    }
    throw error;
  }
  return scope;
}

export async function currentSyncScope(options: { allowStopped?: boolean; allowUnregistered?: boolean } = {}): Promise<SyncScope> {
  const config = await loadConfig(); const credential = await store.loadCredential(); const session = await store.loadSession();
  const binding = await store.loadBinding();
  if (!credential?.subject || !binding) throw new Error('not_connected');
  const boundCollection = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
  const sessionCollection = session?.collection.collectionId;
  // The binding is the user's selection. When a Session authenticates a different
  // Collection, this is not a scope — reporting one would let the engine Push and
  // Pull the Collection the user switched away from (a switch whose mint failed
  // used to leave exactly that Session behind).
  if (sessionCollection !== undefined && isProtocolOpaqueId(boundCollection)
      && sessionCollection !== boundCollection) throw new Error('not_connected');
  const collectionId = sessionCollection ?? boundCollection;
  if (!isProtocolOpaqueId(collectionId)) throw new Error('not_connected');
  const scope: SyncScope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: credential.subject, browserProfileId: binding.browserProfileId,
    collectionId, replicaId: binding.replicaId, generation: Number(binding.generation) };
  // Expired offline renewal can clear Session authority. Keep only the address
  // of existing durable work; the engine must still mint a valid Session before
  // it can Pull/Push or consume a local projection owner.
  // Rebuild journal recovery must locate its newly published identity before
  // that identity has a Session or IDB scope. Ordinary callers still require
  // durable work; the address alone grants no Sync authority.
  if (!session && !options.allowUnregistered) {
    const recorded = await syncState.getScope(scope);
    if (!recorded || recorded.lifecycle === 'retired') throw new Error('not_connected');
  }
  if (!options.allowStopped) await configuredPersonalSyncPolicy()?.capture(scope);
  return scope;
}

/**
 * A browser restart empties the session storage area, so a worker that wakes
 * before any page has asked for auth status holds no credential yet. The
 * Session lane restores it from the browser's cookie. Without this, the
 * start-up Pull gave up and nothing scheduled another until a bookmark changed.
 */
export async function restoredSyncScope(): Promise<SyncScope> {
  try { return await currentSyncScope(); } catch (error) {
    if (await store.loadCredential() || !await store.loadBinding() || !await hasBoundCollection()) throw error;
    await pushSessionAuthority();
    return currentSyncScope();
  }
}

export async function requireSyncScope(): Promise<SyncScope> {
  const owner = await store.loadCredential(), target = await boundCollectionId();
  if (owner?.subject && target) await configuredPersonalSyncPolicy()?.capture({ serverOrigin: owner.serverOrigin, accountId: owner.subject, collectionId: target });
  try { const scope = await currentSyncScope(); if (await store.loadSession()) return scope; }
  catch { /* hydrate a bound collection into a Session */ }
  const credential = await store.loadCredential();
  if (!credential?.subject) throw new Error('not_connected');
  if (!await hasBoundCollection()) throw new Error('collection_required');
  const config = await loadConfig();
  if (!await store.loadSession()) {
    const live = await store.fence.capture();
    await bindingForRequest(live.generation);
    await store.assertWritable(live.generation);
    // Mint through the serialized Session lane rather than calling
    // `createSyncSession` here: the lane re-reads the stored Session under
    // serialization, so a concurrent engine wake cannot mint a second Session
    // that invalidates this one (or the other way round) mid-cycle.
    const authority = await pushSessionAuthority();
    await ensureSyncScope(config, authority.credential, authority.session, live.generation);
  }
  return currentSyncScope();
}

export async function bindingForRequest(expectedGeneration: number) {
  // W2B-P3-1: the memo holds only while storage still holds the binding it names. A sign-out for another account
  // (or a configuration change) removes the binding behind its back, and a request must not use the removed one.
  if (sw.bindingPromise && !await memoNamesStoredBinding(sw.bindingPromise)) sw.bindingPromise = undefined;
  if (!sw.bindingPromise) sw.bindingPromise = store.getOrCreateBinding(expectedGeneration);
  try {
    return await sw.bindingPromise;
  } catch (error) {
    sw.bindingPromise = undefined;
    throw error;
  }
}

async function memoNamesStoredBinding(memo: Promise<StoredAuthBinding>): Promise<boolean> {
  try {
    const held = await memo, stored = await store.loadBinding();
    return stored?.replicaId === held.replicaId && stored.generation === held.generation;
  } catch { return false; }
}

export async function retireLegacyScopeForRemount(options: {
  readonly abandonQueue?: boolean;
} = {}): Promise<{ readonly binding: StoredAuthBinding; readonly retired: true }> {
  const scope = await currentSyncScope();
  await retireScopeIfQueueDrained(syncState, scope, options);
  sw.bindingPromise = undefined;
  const live = await store.fence.capture();
  const binding = await store.bumpBindingGeneration(live.generation);
  return { binding, retired: true };
}

export async function currentSyncStatusAuthority() {
  const config = await loadConfig();
  const [credential, session] = await Promise.all([
    store.loadCredential(), store.loadSession(),
  ]);
  if (!credential?.subject) throw new Error('not_connected');
  // Status locates durable work while paused or offline. A missing Session
  // remains sessionReady=false; reading this identity never mints authority.
  const scope = await currentSyncScope({ allowStopped: true });
  return { config, credential, session, scope };
}

export async function pushSessionAuthority(forceRefresh = false) {
  const observedSessionId = forceRefresh ? (await store.loadSession())?.sessionId ?? null : null;
  return workCoordinator.run('session', (context) =>
    pushSessionAuthorityExclusive(forceRefresh, observedSessionId, context));
}

async function pushSessionAuthorityExclusive(forceRefresh = false, observedSessionId: string | null = null,
  context: AuthorityContext) {
  await store.assertWritable(context.generation);
  const config = await loadConfig();
  let discovered: Awaited<ReturnType<typeof fetchSyncEndpoints>> | undefined;
  const endpoints = async () => discovered ??= await fetchSyncEndpoints(config);
  // Valid cached authority is also needed for local projection recovery while
  // offline. Discover transport only when a Session must be minted or retired.
  const auth = createRuntimeAuth(config, async (credential, session, signal) =>
    retire(await endpoints(), credential, session, signal));
  const before = await store.loadCredential(); let session = await store.loadSession();
  if (session) rememberClientClockSkew(session);
  const target = await boundCollectionId();
  if (before?.subject && target) await configuredPersonalSyncPolicy()?.capture({ serverOrigin: before.serverOrigin, accountId: before.subject, collectionId: target });
  const effectiveForce = shouldForceSessionRefresh(forceRefresh, observedSessionId, session?.sessionId ?? null);
  const credential = await auth.ensureFreshCredential(effectiveForce); session = await store.loadSession();
  const sessionMatchesCredential = session ? await sessionMatchesCredentialAuthority(session, credential) : false;
  // A Session is bound to one Collection. Selecting another Collection leaves a
  // stored Session that authenticates a different scope, so reusing it would
  // Push/Pull against the wrong Collection. The caller used to clear the stored
  // Session before minting, which made the reuse decision and the mint two
  // separate steps: two flows could both read "no Session" and both mint, and
  // the second mint silently advanced the Replica's lifecycle revision, denying
  // the first flow's in-flight Ack as `stale_replica`. Deciding here, inside the
  // serialized Session lane, is what makes the decision and the mint atomic.
  const boundCollection = await boundCollectionId();
  const sessionMatchesCollection = session !== null && authenticatesBoundCollection(session, boundCollection);
  if (Date.now() < sw.sessionRetryNotBefore) {
    const retryAfterMilliseconds = sw.sessionRetryNotBefore - Date.now();
    if (!effectiveForce && session && sessionMatchesCredential && sessionMatchesCollection
        && localTimeOf(session, session.expiresAt) > sw.sessionRetryNotBefore
        && localTimeOf(session, session.replicaLease.expiresAt) > sw.sessionRetryNotBefore) return { credential, session };
    throw new SessionRequestError('rate_limited', retryAfterMilliseconds);
  }
  if (effectiveForce || before?.accessToken !== credential.accessToken || !session || !sessionMatchesCredential
      || !sessionMatchesCollection || syncSessionNeedsRenewal(session)) {
    const prior = session;
    const sessionFetch = credentialGatedFetch(credential.subject && target
      ? personalSyncFetch({ serverOrigin: credential.serverOrigin, accountId: credential.subject, collectionId: target })
      : fetch);
    try { session = await createSyncSession({ endpoints: await endpoints(), credential, replicaProof: await loadBoundReplicaReportProof(), request: await sessionRequest(context.generation, (await endpoints()).maxBatchOperations ?? 1),
      origin: extensionOrigin(), signal: context.signal, fetch: sessionFetch });
      sw.sessionRetryNotBefore = 0; }
    catch (error) {
      if (error instanceof SessionRequestError && error.code === 'rate_limited'
          && error.retryAfterMilliseconds !== undefined) {
        sw.sessionRetryNotBefore = Date.now() + error.retryAfterMilliseconds;
      }
      if (!effectiveForce) await recheckRefusedCredential(auth, error);
      if (!prior) { await clearSessionIfGeneration(context.generation); throw error; }
      try { session = await retryStaleReplicaSession(prior, error, async () => createSyncSession({
        endpoints: await endpoints(), credential, replicaProof: await loadBoundReplicaReportProof(), request: await sessionRequest(context.generation, (await endpoints()).maxBatchOperations ?? 1), origin: extensionOrigin(),
        signal: context.signal, fetch: sessionFetch,
      })); }
      catch {
        // Retention is for a TRANSIENT failure of a Session that is still this
        // Collection's authority. A prior Session for a DIFFERENT Collection is
        // not a fallback: keeping it let Push/Pull run against the Collection the
        // user just switched away from, because `currentSyncScope` preferred the
        // Session's Collection over the binding.
        if (prior !== null && authenticatesBoundCollection(prior, boundCollection)
            && retainSessionAfterTransientRenewalFailure(prior, error)) throw error;
        await clearSessionIfGeneration(context.generation); throw error;
      }
    }
    await store.saveSession(session, context.generation);
    rememberClientClockSkew(session);
    await recordClockSkew(syncState, await ensureSyncScope(config, credential, session, context.generation), session);
  }
  return { credential, session };
}

/**
 * W2B-P1-2: a 401 from the Session route says the server no longer accepts this credential, although its cookie and
 * stored expiry still look fine (a web sign-out, a password change, an administrator). Ask the identity server once.
 * When it agrees, this signs out and keeps the replica; retrying a dead credential used to go on until it expired.
 */
async function recheckRefusedCredential(auth: ReturnType<typeof createRuntimeAuth>, error: unknown): Promise<void> {
  if (!(error instanceof SessionRequestError) || error.code !== 'credential_revoked') return;
  try { await auth.ensureFreshCredential(true); }
  catch (check) { if (safeError(check) === 'authentication_required') throw check; }
}

/**
 * Whether a stored Session is usable authority for the Collection the user has
 * bound.
 *
 * A missing binding is not evidence that the Session belongs elsewhere: the
 * bound Collection is derived FROM the Session when the key is absent
 * (`currentSyncScope`), so the Session is the only authority available and
 * refusing it would only turn cached offline authority into a failed mint. A
 * binding that is present and DIFFERENT is evidence — that Session authenticates
 * another Collection and must never be used for this one.
 */
function authenticatesBoundCollection(session: StoredSession, boundCollection: string | null): boolean {
  return boundCollection === null || session.collection.collectionId === boundCollection;
}

async function clearSessionIfGeneration(expected: number) {
  const current = await store.fence.read();
  if (!current.revoked && current.generation === expected) await store.clearSession();
}

/**
 * Credential refresh and session mint for an already-connected account run
 * outside the auth.status critical path. The auth lane keeps the freshen
 * serialized with login/logout so it cannot race credential writes.
 */
export function scheduleSessionFreshen(): void {
  if (sw.sessionFreshenQueued) return;
  sw.sessionFreshenQueued = true;
  void workCoordinator.run('auth', async () => {
    try {
      const authority = await pushSessionAuthority();
      const live = await store.fence.capture();
      await ensureSyncScope(await loadConfig(), authority.credential, authority.session, live.generation);
    } catch { /* Better Auth session is enough for the settings page; COLP can retry later. */ }
    try {
      const auth = createRuntimeAuth(await loadConfig());
      await auth.hydrateAvatar();
      await writeAuthSnapshot(await auth.status());
    } catch { /* snapshot is best-effort */ }
  }).finally(() => { sw.sessionFreshenQueued = false; });
}

export async function stateAfterFailure(error: unknown) { const config = await loadConfig(); const code = safeError(error);
  return { status: code === 'offline' ? 'offline' as const : code.includes('policy') || code.includes('managed_')
    ? 'policy_blocked' as const : 'error' as const, environment: config.environment, serverOrigin: config.serverOrigin, errorCode: code }; }

async function loadBoundReplicaReportProof() {
  const [credential, binding] = await Promise.all([store.loadCredential(), store.loadBinding()]);
  if (!credential?.subject || !binding) return undefined;
  return store.loadReplicaReportProof({ serverOrigin: credential.serverOrigin, accountId: credential.subject,
    replicaId: binding.replicaId, browserProfileId: binding.browserProfileId, generation: Number(binding.generation) });
}
