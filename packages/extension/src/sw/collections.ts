import { colpCredentialHeaders } from '../auth-client.js';
import { COLLECTIONS_CACHE, parseCollectionsCache, writeCollectionsCache, clearCollectionsCache,
  forgetCollectionBindingIfAbsent, selectPrivateBookmarkLibraries } from '../collections-cache.js';
import {
  LIBRARY_CREATE_IDEMPOTENCY, libraryCreateIdempotency, parseOwnedCollectionRecord,
  postPrivateBookmarkLibrary,
} from '../library-create.js';
import type { CollectionCreateResponse, CollectionsResponse, PublicCollectionChoice } from '../types.js';
import { extensionOrigin } from './runtime.js';
import { store } from './runtime.js';
import { createRuntimeAuth, loadConfig, boundCollectionId } from './scope.js';
import { collectionAvailability } from '../collection-availability.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import type { PersonalSyncIdentity } from '../personal-sync-policy.js';
import type { StoredCredential } from '../types.js';

async function fetchOwnedCollections(auth: ReturnType<typeof createRuntimeAuth>, credential: StoredCredential) {
  const request = (current: StoredCredential) => fetch(`${current.serverOrigin.replace(/\/$/u, '')}/colp/v0.1/sync/collections`, {
    method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', ...colpCredentialHeaders(current.accessToken), Origin: extensionOrigin() },
  });
  let response = await request(credential);
  if (response.status === 401) {
    let fresh: StoredCredential;
    try { fresh = await auth.ensureFreshCredential(true); }
    catch { return { response, credential }; }
    if (fresh.subject !== credential.subject || fresh.serverOrigin !== credential.serverOrigin) {
      return { response, credential };
    }
    credential = fresh;
    response = await request(credential);
  }
  return { response, credential };
}

export async function verifyCollectionAvailability(identity: PersonalSyncIdentity & { collectionId: string }) {
  const config = await loadConfig(), auth = createRuntimeAuth(config), credential = await auth.ensureFreshCredential();
  if (credential.subject !== identity.accountId || credential.serverOrigin !== identity.serverOrigin) throw new Error('account_switch');
  try {
    const { response } = await fetchOwnedCollections(auth, credential);
    if (!response.ok) return 'unknown' as const;
    return collectionAvailability(await response.json(), identity.collectionId, parseOwnedCollectionRecord);
  } catch { return 'unknown' as const; }
}

export async function handleCollectionList(): Promise<CollectionsResponse> {
  const config = await loadConfig();
  const auth = createRuntimeAuth(config);
  let credential: Awaited<ReturnType<typeof auth.ensureFreshCredential>>;
  try { credential = await auth.ensureFreshCredential(); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'authentication_required';
    return { ok: false, error: code === 'offline' ? 'offline' : 'authentication_required' };
  }
  const cached = parseCollectionsCache((await chrome.storage.local.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE],
    credential.subject ? { accountId: credential.subject } : undefined);
  const authority = await store.fence.capture(), target = await boundCollectionId(), policy = configuredPersonalSyncPolicy();
  const identity = credential.subject && target ? { serverOrigin: credential.serverOrigin,
    accountId: credential.subject, collectionId: target } : null;
  const before = policy && identity ? await policy.read(identity) : null;
  const isCurrent = async () => {
    const current = await store.loadCredential(), generation = await store.fence.read();
    if (authority.signal.aborted || generation.revoked || generation.generation !== authority.generation
      || current?.subject !== credential.subject || current?.serverOrigin !== credential.serverOrigin
      || await boundCollectionId() !== target) return false;
    return !policy || !identity || (await policy.read(identity)).revision === before?.revision;
  };
  let response: Response;
  try {
    ({ response, credential } = await fetchOwnedCollections(auth, credential));
  } catch { return cached ? { ok: true, collections: selectPrivateBookmarkLibraries(cached) } : { ok: false, error: 'offline' }; }
  if (response.status === 401 || response.status === 403) {
    if (await isCurrent()) await clearCollectionsCache();
    return { ok: false, error: 'collections_unauthorized' };
  }
  if (!response.ok) {
    return cached ? { ok: true, collections: selectPrivateBookmarkLibraries(cached) } : { ok: false, error: 'collections_unavailable' };
  }
  let body: unknown; try { body = await response.json(); } catch {
    return cached ? { ok: true, collections: selectPrivateBookmarkLibraries(cached) } : { ok: false, error: 'collections_unavailable' };
  }
  if (!body || typeof body !== 'object' || !Array.isArray((body as { readonly items?: unknown }).items)) {
    return cached ? { ok: true, collections: selectPrivateBookmarkLibraries(cached) } : { ok: false, error: 'collections_unavailable' };
  }
  const collections: PublicCollectionChoice[] = (body as { items: unknown[] }).items.flatMap((item) => {
    const parsed = parseOwnedCollectionRecord(item);
    return parsed ? [parsed] : [];
  });
  const libraries = selectPrivateBookmarkLibraries(collections);
  // A response belongs to the authority, target and policy observed before its
  // request. It cannot invalidate or replace state created while it was in flight.
  const current = await isCurrent();
  if (credential.subject && current) {
    await writeCollectionsCache({ accountId: credential.subject,
      accountLabel: credential.accountLabel ?? credential.subject, collections: libraries });
  }
  if (policy && identity && before && before.mode !== 'disconnected' && current
    && collectionAvailability(body, identity.collectionId, parseOwnedCollectionRecord) === 'unavailable') {
    try { await policy.write(identity, 'target-unavailable', 'target-unavailable', before.revision); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'personal_sync_preview_stale') throw error; }
  }
  // Preserve unavailable target identity for explicit disconnect/rebind. A partial
  // or malformed listing never proves deletion. Legacy hosts keep their contract.
  if (!policy && current) await forgetCollectionBindingIfAbsent(libraries);
  return { ok: true, collections: libraries };
}

export async function handleCollectionCreate(title: string): Promise<CollectionCreateResponse> {
  const trimmed = title.trim();
  if (!trimmed) return { ok: false, error: 'invalid_request' };
  const config = await loadConfig();
  const auth = createRuntimeAuth(config);
  let credential: Awaited<ReturnType<typeof auth.ensureFreshCredential>>;
  try { credential = await auth.ensureFreshCredential(); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'authentication_required';
    return { ok: false, error: code === 'offline' ? 'offline' : 'authentication_required' };
  }
  const stored = (await chrome.storage.local.get(LIBRARY_CREATE_IDEMPOTENCY))[LIBRARY_CREATE_IDEMPOTENCY];
  const idempotency = libraryCreateIdempotency(stored, trimmed, () => crypto.randomUUID());
  await chrome.storage.local.set({ [LIBRARY_CREATE_IDEMPOTENCY]: idempotency });
  const created = await postPrivateBookmarkLibrary({
    title: trimmed, serverOrigin: config.serverOrigin, accessToken: credential.accessToken,
    origin: extensionOrigin(), idempotencyKey: idempotency.key,
  });
  if (!created.ok || !credential.subject) return created;
  const cached = parseCollectionsCache((await chrome.storage.local.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE],
    { accountId: credential.subject }) ?? [];
  const collections = selectPrivateBookmarkLibraries([
    ...cached.filter((item) => item.id !== created.collection.id), created.collection,
  ]);
  await writeCollectionsCache({ accountId: credential.subject,
    accountLabel: credential.accountLabel ?? credential.subject, collections });
  return created;
}

export async function resolveOwnedCollectionRootId(collectionId: string): Promise<string | undefined> {
  const listed = await handleCollectionList().catch(() => ({ ok: false as const }));
  if (listed.ok) {
    const match = listed.collections.find((item) => item.id === collectionId && item.rootNodeId);
    if (match?.rootNodeId) return match.rootNodeId;
  }
  const cached = parseCollectionsCache((await chrome.storage.local.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE]);
  return cached?.find((item) => item.id === collectionId)?.rootNodeId;
}
