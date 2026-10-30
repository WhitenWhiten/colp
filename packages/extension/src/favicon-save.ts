import { rememberDisplayFavicon } from './favicon-display-cache.js';
import { captureTabFavicon } from './favicon-capture.js';
import { isBookmarkHostAllowedForAutoUpload } from './favicon-host.js';
import type { createFaviconSidecarStore } from './favicon-sidecar-store.js';
import type { SyncScope } from './sync-state-store.js';

export interface SaveBookmarkCaptureInput {
  readonly title: string; readonly url: string; readonly favIconUrl: string;
  readonly privateLocal: boolean; readonly parentNativeId?: string;
  readonly index?: number;
  /** Explicit destination for a private-local save (a configured private
   * root). Without it a private save keeps Chrome's default placement. */
  readonly privateParentNativeId?: string;
  readonly collectionId?: string;
  readonly bookmarks: { getChildren?(parentId: string): Promise<readonly { readonly id: string;
    readonly title?: string; readonly url?: string; readonly index?: number; readonly dateAdded?: number }[]>;
    getTree?(): Promise<readonly { readonly id: string; readonly children?: readonly {
      readonly id: string; readonly url?: string;
    }[] }[]>;
    create(bookmark: { parentId?: string; index?: number; title?: string; url?: string }): Promise<{
    readonly id: string; readonly title: string; readonly url?: string; readonly dateAdded?: number }>; };
  readonly sidecar: ReturnType<typeof createFaviconSidecarStore>;
  readonly onNativeCreated?: (node: { readonly id: string; readonly dateAdded?: number }) => Promise<void>;
  readonly fetch?: typeof fetch; readonly randomUUID?: () => string; readonly now?: () => number;
}

export async function resolveSelectedRootNativeId(
  store: { getScope(scope: SyncScope): Promise<{ readonly selectedRoots: readonly string[] } | null>;
    getMappingByColpId(scope: SyncScope, colpId: string): Promise<{ readonly nativeId: string } | null>; },
  scope: SyncScope,
): Promise<string | undefined> {
  const recorded = await store.getScope(scope);
  const root = recorded?.selectedRoots[0];
  if (!root) return undefined;
  return (await store.getMappingByColpId(scope, root))?.nativeId;
}

export async function saveBookmarkWithFaviconCapture(input: SaveBookmarkCaptureInput): Promise<{
  readonly nativeId: string; readonly captured: boolean; readonly parentId?: string;
}> {
  const destination = input.privateLocal ? input.privateParentNativeId : input.parentNativeId;
  const useParent = typeof destination === 'string' && destination.length > 0;
  const created = await input.bookmarks.create({
    title: input.title, url: input.url, ...(useParent ? { parentId: destination } : {}),
    ...(input.index === undefined ? {} : { index: input.index }),
  });
  await input.onNativeCreated?.(created);
  let captured = false;
  const icon = input.privateLocal ? await capturePrivateDisplayIcon(input.url, input.favIconUrl)
    : isBookmarkHostAllowedForAutoUpload(input.url)
      ? await captureTabFavicon({ favIconUrl: input.favIconUrl, tabUrl: input.url, fetch: input.fetch }).catch(() => null) : null;
  if (icon) await rememberDisplayFavicon(input.url, icon.bytes).catch(() => undefined);
  if (!input.privateLocal && useParent && input.collectionId && isBookmarkHostAllowedForAutoUpload(input.url)) {
    try {
      if (icon) {
        const commandId = (input.randomUUID ?? (() => crypto.randomUUID()))().toLowerCase();
        await input.sidecar.put({
          nativeId: created.id, contentType: icon.contentType, bytes: icon.bytes, commandId,
          collectionId: input.collectionId, createdAt: (input.now ?? Date.now)(), attempts: 0, notBefore: 0,
          pageUrl: input.url,
        });
        captured = true;
      }
    } catch { /* Saved UX must not fail because capture or sidecar write failed. */ }
  }
  return { nativeId: created.id, captured,
    ...(useParent && !input.privateLocal ? { parentId: input.parentNativeId } : {}) };
}

/** Private saves read the browser resource only; no website or cloud request. */
async function capturePrivateDisplayIcon(pageUrl: string, favIconUrl: string) {
  if (!favIconUrl) return null;
  try {
    const resource = new URL(chrome.runtime.getURL('/_favicon/'));
    resource.searchParams.set('pageUrl', pageUrl); resource.searchParams.set('size', '32');
    return await captureTabFavicon({ tabUrl: pageUrl, favIconUrl: pageUrl,
      fetch: (_url, init) => fetch(resource, init) });
  } catch { return null; }
}
