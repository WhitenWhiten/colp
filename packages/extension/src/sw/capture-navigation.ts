import { currentSyncScope } from './scope.js';
import { syncState } from './runtime.js';
import { bookmarkPreferencesScopeKey } from '../bookmark-preferences.js';
import { currentCaptureScope, assertCaptureScope } from './capture-native.js';
export type CaptureNavigationRequest = { readonly kind: 'known.capture.navigation.get' }
  | { readonly kind: 'known.capture.navigation.resolve'; readonly nodeId: string; readonly collectionId: string | null }
  | { readonly kind: 'known.capture.navigation.set'; readonly hash: string };
export function validCaptureNavigation(value: unknown): value is CaptureNavigationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'known.capture.navigation.resolve') return Object.keys(raw).length === 3 && typeof raw.nodeId === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(raw.nodeId)
    && (raw.collectionId === null || typeof raw.collectionId === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(raw.collectionId));
  return raw.kind === 'known.capture.navigation.get' ? Object.keys(raw).length === 1
    : raw.kind === 'known.capture.navigation.set' && Object.keys(raw).length === 2 && typeof raw.hash === 'string'
      // Every pane the router can write must be listed, or the last-page memory never takes.
      && raw.hash.length <= 1024 && /^#(?:capture|saving|history|subscriptions|ai|general|help|account|bookmarks|collection|folders|import|sync|credits|native-wait-settings)(?:[/?]|$)/u.test(raw.hash)
      && !/[\u0000-\u001f]/u.test(raw.hash);
}
export async function handleCaptureNavigation(request: CaptureNavigationRequest) {
  const scope = await currentCaptureScope(), identity = bookmarkPreferencesScopeKey(scope.serverOrigin, scope.accountId);
  if (request.kind === 'known.capture.navigation.resolve') {
    if (!scope.collectionId || request.collectionId !== scope.collectionId) throw new Error('capture_scope_changed');
    const syncScope = await currentSyncScope(), mapping = await syncState.getMappingByColpId(syncScope, request.nodeId);
    await assertCaptureScope(scope); return { ok: true, nativeId: mapping?.nativeId ?? null };
  }
  const key = `known.capture.navigation.v1.${identity}`;
  if (request.kind === 'known.capture.navigation.set') {
    await assertCaptureScope(scope); await chrome.storage.local.set({ [key]: request.hash }); return { ok: true };
  }
  const hash = (await chrome.storage.local.get(key))[key]; await assertCaptureScope(scope);
  return { ok: true, identity, hash: typeof hash === 'string' ? hash : null };
}
