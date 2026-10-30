import { fetchExtensionFaviconSource } from '../favicon-helper-client.js';
import { loadManifestCloud } from '../cloud-capability.js';
import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { extensionOrigin, syncState } from './runtime.js';
import { currentSyncScope, loadConfig, pushSessionAuthority } from './scope.js';

/** Read the authorized source on demand; never persist account icons in the device cache. */
export async function readCloudDisplayFavicon(nativeId: string, pageUrl: string) {
  try {
    if (await isSubscriptionExcluded(nativeId)) return { ok: false };
    const scope = await currentSyncScope();
    const mapping = await syncState.getMappingByNativeId(scope, nativeId);
    if (!mapping || mapping.colpId.startsWith('pending-')) return { ok: false };
    const node = (await chrome.bookmarks.get(nativeId))[0];
    if (node?.url !== pageUrl) return { ok: false };
    const config = await loadConfig();
    if (!await loadManifestCloud(config.serverOrigin)) return { ok: false };
    const authority = await pushSessionAuthority();
    const { source } = await fetchExtensionFaviconSource({
      serverOrigin: config.serverOrigin, accessToken: authority.credential.accessToken, origin: extensionOrigin(),
    }, scope.collectionId, mapping.colpId);
    if (JSON.stringify(await currentSyncScope()) !== JSON.stringify(scope)
      || (await chrome.bookmarks.get(nativeId))[0]?.url !== pageUrl) return { ok: false };
    if (source.effectiveMode === 'none') return { ok: true, suppressed: true, iconUrl: null };
    if (!source.iconUrl) return { ok: false };
    const icon = new URL(source.iconUrl);
    if (icon.origin !== new URL(config.serverOrigin).origin || icon.username || icon.password
      || !/^\/api\/v1\/favicon\/[a-f\d-]{36}$/i.test(icon.pathname) || icon.search || icon.hash) return { ok: false };
    return { ok: true, suppressed: false, iconUrl: icon.href };
  } catch { return { ok: false }; }
}
