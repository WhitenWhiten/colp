import { colpCredentialHeaders } from '../auth-client.js';
import { COLLECTION_BINDING, LIBRARY_STATE, parseLibrary, parseLibraryState, type Library, type LibraryState } from '../library.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import type { PersonalSyncIdentity } from '../personal-sync-policy.js';
import { browserMetadataSyncPolicy } from '../metadata-sync-policy.js';
import { store, extensionOrigin, workCoordinator } from './runtime.js';
import { createRuntimeAuth, loadConfig, boundCollectionId } from './scope.js';

async function fetchLibrary() {
  const auth = createRuntimeAuth(await loadConfig());
  let credential = await auth.ensureFreshCredential();
  const request = () => fetch(`${credential.serverOrigin.replace(/\/$/u, '')}/colp/v0.1/sync/library`, {
    method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', ...colpCredentialHeaders(credential.accessToken), Origin: extensionOrigin() },
  });
  let response = await request();
  if (response.status === 401) {
    const previous = credential;
    credential = await auth.ensureFreshCredential(true);
    if (credential.subject !== previous.subject || credential.serverOrigin !== previous.serverOrigin) throw new Error('account_switch');
    response = await request();
  }
  return { response, credential };
}

/** Fetch off the auth lane; publish only if account, origin, generation and binding still match. */
export async function ensureLibraryBinding(options: { readonly login?: boolean; readonly authLane?: boolean } = {}): Promise<Library | undefined> {
  const credential = await store.loadCredential();
  if (!credential?.subject) return;
  const authority = await store.fence.capture();
  const target = await boundCollectionId();
  const policy = configuredPersonalSyncPolicy();
  const identity = { serverOrigin: credential.serverOrigin, accountId: credential.subject, ...(target ? { collectionId: target } : {}) };
  const before = policy ? await policy.read(identity) : undefined;
  const isCurrent = async () => {
    const current = await store.loadCredential(), generation = await store.fence.read();
    return !authority.signal.aborted && !generation.revoked && generation.generation === authority.generation
      && current?.subject === credential.subject && current?.serverOrigin === credential.serverOrigin
      && await boundCollectionId() === target
      && (!policy || (await policy.read(identity)).revision === before?.revision);
  };
  const fetched = await fetchLibrary();
  if (fetched.credential.subject !== credential.subject || fetched.credential.serverOrigin !== credential.serverOrigin) return;
  const unsupported = fetched.response.status === 404;
  if (!unsupported && !fetched.response.ok) throw new Error('library_unavailable');
  const library = unsupported ? undefined : parseLibrary(await fetched.response.json());
  if (!unsupported && !library) throw new Error('library_unavailable');
  const publish = async () => {
    if (!await isCurrent()) return undefined;
    const state: LibraryState = { accountId: credential.subject!, serverOrigin: credential.serverOrigin,
      status: unsupported ? 'unsupported' : 'ready', ...(library ? { library } : {}) };
    if (!library) {
      if (policy && identity && before?.mode !== 'disconnected' && before?.mode !== 'paused') await policy.write(identity, 'target-unavailable', 'target-unavailable', before?.revision);
      await store.clearSession();
      await chrome.storage.local.remove(COLLECTION_BINDING);
      await chrome.storage.local.set({ [LIBRARY_STATE]: state });
      return;
    }
    // An explicit disconnect survives worker restarts. Signing in again is a
    // new connection intent, and binds the account library without a picker.
    const nextIdentity = { accountId: credential.subject!, serverOrigin: credential.serverOrigin, collectionId: library.id };
    const nextPolicy = policy ? await policy.read(nextIdentity) : undefined;
    if (!options.login && nextPolicy?.mode === 'disconnected') return;
    if (!target) {
      await browserMetadataSyncPolicy().write(nextIdentity, false);
    }
    const recoveredTarget = nextPolicy?.mode === 'target-unavailable'
      && (nextPolicy.collectionId === null || nextPolicy.collectionId === library.id);
    const signedOutPause = options.login && nextPolicy?.mode === 'paused' && nextPolicy.reason === 'signed-out';
    if (policy && (recoveredTarget || signedOutPause || (!target && (nextPolicy?.mode === 'enabled'
      || (options.login && nextPolicy?.mode === 'disconnected'))))) {
      await policy.write(nextIdentity, 'enabled', 'user', before?.revision);
    }
    await store.assertWritable(authority.generation);
    await chrome.storage.local.set({ [LIBRARY_STATE]: state, [COLLECTION_BINDING]: library.id });
    return library;
  };
  return options.login || options.authLane ? publish() : workCoordinator.run('auth', publish);
}

export async function resolveLibraryRootId(collectionId: string): Promise<string | undefined> {
  const credential = await store.loadCredential();
  const state = parseLibraryState((await chrome.storage.local.get(LIBRARY_STATE))[LIBRARY_STATE]);
  if (state?.status === 'ready' && state.library?.id === collectionId
    && state.accountId === credential?.subject && state.serverOrigin === credential?.serverOrigin) return state.library.rootNodeId;
  const library = await ensureLibraryBinding();
  return library?.id === collectionId ? library.rootNodeId : undefined;
}
export async function fetchAccountLibrary(identity: PersonalSyncIdentity): Promise<Library | undefined> {
  try {
    const { response, credential } = await fetchLibrary();
    if (credential.subject !== identity.accountId || credential.serverOrigin !== identity.serverOrigin) throw new Error('account_switch');
    if (!response.ok) return;
    return parseLibrary(await response.json());
  } catch { return; }
}
export async function verifyLibraryAvailability(identity: PersonalSyncIdentity & { collectionId: string }) {
  const library = await fetchAccountLibrary(identity);
  return !library ? 'unknown' as const : library.id === identity.collectionId ? 'available' as const : 'unavailable' as const;
}
export async function libraryUnsupported(): Promise<boolean> {
  const credential = await store.loadCredential();
  const state = parseLibraryState((await chrome.storage.local.get(LIBRARY_STATE))[LIBRARY_STATE]);
  return state?.status === 'unsupported' && state.accountId === credential?.subject && state.serverOrigin === credential?.serverOrigin;
}

/** Startup and status reconciliation retry discovery without holding the Session lane. */
export async function bindLibraryOnStartup(): Promise<void> {
  if (!await boundCollectionId()) await ensureLibraryBinding();
}
