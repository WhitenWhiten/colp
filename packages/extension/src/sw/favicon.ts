import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { loadManifestCloud } from '../cloud-capability.js';
import { drainFaviconSidecars } from '../favicon-upload.js';
import { clearCapturedFavicon } from '../favicon-clear.js';
import { resolveSelectedRootNativeId } from '../favicon-save.js';
import { writeSaveContextCache } from '../save-context-cache.js';
import { FAVICON_SIDECAR_ALARM } from '../favicon-sidecar-store.js';
import { FaviconHelperHttpError, fetchExtensionFaviconPolicy, type IconPolicyDto } from '../favicon-helper-client.js';
import type { SyncScope } from '../sync-state-store.js';
import type { BuildConfig, FaviconClearResponse } from '../types.js';
import { waitUntilBookmarkIngressOpen } from './bookmarks.js';
import { extensionOrigin, faviconSidecar, safeError, syncState } from './runtime.js';
import { provisionDefaultSyncRoot, resolvePrivateRootNativeId } from './roots.js';
import { currentSyncScope, loadConfig, pushSessionAuthority } from './scope.js';

export async function drainFaviconSidecarsForCurrentScope(): Promise<void> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch { return; }
  // Bound the sidecar: rows of no-longer-active collections are pruned once
  // they exceed the TTL (the active collection's rows are never touched).
  await faviconSidecar.prune(scope.collectionId).catch(() => undefined);
  const pending = await faviconSidecar.list(scope.collectionId).catch(() => []);
  if (pending.length === 0) return;
  let authority: Awaited<ReturnType<typeof pushSessionAuthority>>;
  let config: BuildConfig;
  try { authority = await pushSessionAuthority(); config = await loadConfig(); } catch { return; }
  const cloud = await loadManifestCloud(config.serverOrigin);
  try {
    const drained = await drainFaviconSidecars({
      cloudEnabled: cloud,
      sidecar: faviconSidecar, collectionId: scope.collectionId,
      dispatch:(id,send)=>withSubscriptionRead(async()=>{if(await isSubscriptionExcluded(id))throw new Error('subscription_icon_excluded');return send();}),
      lookupNodeId: async (nativeId) => {
        if(await isSubscriptionExcluded(nativeId))return null;
        const mapping = await syncState.getMappingByNativeId(scope, nativeId);
        if (!mapping || mapping.colpId.startsWith('pending-')) return null;
        return mapping.colpId;
      },
      bookmarkUrl: async (nativeId) => {
        try {
          const nodes = await chrome.bookmarks.get(nativeId);
          return typeof nodes[0]?.url === 'string' ? nodes[0].url : null;
        } catch { return null; }
      },
      accessToken: authority.credential.accessToken, origin: extensionOrigin(), serverOrigin: config.serverOrigin,
      schedule: (delay) => chrome.alarms.create(FAVICON_SIDECAR_ALARM, { when: Date.now() + Math.max(1_000, delay) }),
    });
    if (drained === 'unsupported') return;
  } catch { /* Saved bookmark UX must not fail because helper upload failed. */ }
}

/**
 * FO-04 clear consumer in the worker: resolves the current scope + bookmark
 * mapping, then runs the DELETE flow (policy + source + If-Match +
 * Known-Favicon-Policy-Revision + fresh Known-Command-Id) and discards the
 * queued sidecar row on success. This is the honest call site behind the
 * popup "Clear auto-captured icon" action and the e2e clear leg.
 */
export async function clearFaviconForCurrentScope(nativeId: string): Promise<FaviconClearResponse> {
  if(await isSubscriptionExcluded(nativeId))return {ok:false,error:'clear_failed'};
  try {
    const scope = await currentSyncScope();
    const mapping = await syncState.getMappingByNativeId(scope, nativeId);
    if (!mapping || mapping.colpId.startsWith('pending-')) return { ok: false, error: 'bookmark_unmapped' };
    const authority = await pushSessionAuthority();
    const config = await loadConfig();
    const outcome = await clearCapturedFavicon({
      sidecar: faviconSidecar, collectionId: scope.collectionId, nativeId, nodeId: mapping.colpId,
      fetch:(input,init)=>withSubscriptionRead(async()=>{if(await isSubscriptionExcluded(nativeId))throw new Error('subscription_icon_excluded');return fetch(input,init);}),
      accessToken: authority.credential.accessToken, origin: extensionOrigin(), serverOrigin: config.serverOrigin,
    });
    return { ok: true, outcome: outcome.status };
  } catch {
    return { ok: false, error: 'clear_failed' };
  }
}

/** Local scope lookup only: no provisioning, session renewal, or engine wake. */
export async function resolveLocalSaveContext() {
  try { return { ok: true as const, collectionId: (await currentSyncScope()).collectionId }; }
  catch { return { ok: false as const }; }
}

export async function resolveFaviconSaveContext() {
  try {
    const scope = await currentSyncScope();
    const parentNativeId = await resolveSelectedRootNativeId(syncState, scope)
      ?? await provisionDefaultSyncRoot(scope);
    const privateParentNativeId = await resolvePrivateRootNativeId(scope);
    if (parentNativeId) {
      await waitUntilBookmarkIngressOpen(scope);
      // Remember the resolved folders so an offline popup can still save
      // inside the sync boundary (or the private root) without a session.
      await writeSaveContextCache({ collectionId: scope.collectionId, parentNativeId,
        ...(privateParentNativeId ? { privateParentNativeId } : {}) }).catch(() => undefined);
    }
    return { ok: true as const, collectionId: scope.collectionId,
      ...(parentNativeId ? { parentNativeId } : {}),
      ...(privateParentNativeId ? { privateParentNativeId } : {}) };
  } catch {
    return { ok: false as const };
  }
}

/**
 * FO-04 read-only server icon-policy projection for the options/save UI.
 * Consumes the same helper policy endpoint as the drain, so the settings hint
 * always reflects what the helper will enforce.
 */
export async function readFaviconPolicyForCurrentScope(): Promise<
  { readonly ok: true; readonly policy: IconPolicyDto } | { readonly ok: false; readonly error: string }
> {
  try {
    const authority = await pushSessionAuthority();
    const config = await loadConfig();
    if (!(await loadManifestCloud(config.serverOrigin))) return { ok: false, error: 'unsupported' };
    const read = await fetchExtensionFaviconPolicy({
      accessToken: authority.credential.accessToken, origin: extensionOrigin(),
      serverOrigin: config.serverOrigin,
    });
    return { ok: true, policy: read.policy };
  } catch (error) {
    if (error instanceof FaviconHelperHttpError && error.status === 404) return { ok: false, error: 'unsupported' };
    return { ok: false, error: safeError(error) };
  }
}
