import { createExtensionWorkCoordinator } from '../authority-fence.js';
import { createBookmarkEventQueue } from '../bookmark-event-queue.js';
import { createCredentialStore, type StorageArea } from '../credential-store.js';
import { createSplitCredentialStorage } from './credential-storage.js';
import { createFaviconSidecarStore } from '../favicon-sidecar-store.js';
import type { ImportConversionResult } from '../import-preview.js';
import { createSyncStateStore, type SyncScope } from '../sync-state-store.js';
import type { BuildConfig, StoredAuthBinding } from '../types.js';

export { COLLECTION_BINDING } from '../library.js';
export const WELCOME_FLAG = 'known.onboarding.installed.v1';

export const BOOKMARK_RECOVERY_ALARM = 'known-bookmark-capture-recovery';
/**
 * Low-frequency bookmark reconciliation.
 *
 * Every other recovery path is opportunistic: browser startup, a capture that
 * failed to stage, or the bounded one-shot alarm that a failure schedules. If
 * the worker is evicted while a capture is in flight, and no later event
 * happens to schedule anything, nothing ever re-runs the reconcile — the
 * capture stays missing until the user restarts the browser. A repeating alarm
 * makes the reconciliation guaranteed rather than contingent, at the cost of one
 * worker wake per interval.
 *
 * Chromium clamps repeating alarms to a 30-second floor; the interval is well
 * above it and `chrome.alarms` persists the registration across restarts.
 */
export const BOOKMARK_RECONCILE_ALARM = 'known-bookmark-reconcile';
export const BOOKMARK_RECONCILE_PERIOD_MINUTES = 180;
export const DEFAULT_SYNC_FOLDER_TITLE = 'Know-N';

/**
 * Credential authority is split across the session and local areas.
 *
 * The session cookie is a bearer credential. `chrome.storage.session` is pinned
 * to `TRUSTED_CONTEXTS` so content scripts cannot read it, and it is cleared
 * when the browser session ends, which is the lifetime a bearer credential
 * wants.
 *
 * NOTE the limit of that pin, because it is easy to overclaim: Chromium defines
 * "trusted contexts" as the extension's own pages AND its service workers. The
 * options and popup pages are trusted contexts, so they can still read the
 * session area — only untrusted contexts (content scripts) are excluded. The
 * move therefore narrows the exposure and shortens its lifetime; it does not
 * make the credential unreadable from an injected extension page.
 *
 * The access level must be set before anything reads the area: `storage.session`
 * defaults to `TRUSTED_AND_UNTRUSTED_CONTEXTS`, which would leave the credential
 * readable from content scripts.
 */
async function createCredentialArea(): Promise<StorageArea> {
  const area = chrome.storage.session;
  if (typeof area.setAccessLevel !== 'function') {
    throw new Error('credential_storage_requires_set_access_level');
  }
  await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return area;
}

/** Resolves once the session area is pinned; every secret read awaits it. */
export const credentialAreaReady = createCredentialArea();
/**
 * Identity and secrets go to different areas: see
 * {@link createSplitCredentialStorage}. The identity half must survive a
 * browser restart or every durable row keyed by the scope would be orphaned.
 */
export const store = createCredentialStore(createSplitCredentialStorage(chrome.storage.local));
export const workCoordinator = createExtensionWorkCoordinator(store.fence);
export const syncState = createSyncStateStore();
export const faviconSidecar = createFaviconSidecarStore();

export type EventEvidenceFault = 'after_sequence' | 'after_queue' | 'after_event' | 'before_stage';
export type OutboundBoundaryEvidence = 'before_attempt_persist' | 'after_attempt_persist';
export interface RootTokenSet {
  readonly viewId: string;
  readonly scopeKey: string;
  readonly entries: ReadonlyMap<string, { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }>;
}

/** Shared mutable service-worker globals. One object so extracted modules share identity. */
export const sw = {
  configPromise: undefined as Promise<BuildConfig> | undefined,
  sessionRetryNotBefore: 0,
  bindingPromise: undefined as Promise<StoredAuthBinding> | undefined,
  sessionFreshenQueued: false,
  confirmedOnlineWakePending: false,
  coalescedOnlineWake: undefined as Promise<unknown> | undefined,
  importPreviews: new Map<string, ImportConversionResult>(),
  bookmarkEventQueue: undefined as ReturnType<typeof createBookmarkEventQueue> | undefined,
  bookmarkEventScopeKey: undefined as string | undefined,
  eventEvidenceScope: undefined as SyncScope | undefined,
  eventEvidenceFault: undefined as EventEvidenceFault | undefined,
  outboundPushFaultEvidence: undefined as 'after_receipt' | undefined,
  outboundLeaseDurationEvidence: undefined as number | undefined,
  outboundBoundaryEvidence: undefined as OutboundBoundaryEvidence | undefined,
  rootViewTokens: undefined as RootTokenSet | undefined,
};

export function rootScopeKey(scope: SyncScope) {
  return [scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation].join('\u001f');
}

export async function hasBookmarkPermission() {
  try { return await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch { return false; }
}

export function extensionOrigin(): string {
  return chrome.runtime.getURL('').replace(/\/$/u, '');
}

export function safeError(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { readonly code?: unknown } : undefined;
  const code = record?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/.test(code)) return code;
  const value = error instanceof Error ? error.message : 'operation_failed';
  // A code-shaped message is the real code; only prose (e.g. "Failed to fetch")
  // falls back to the network classification.
  if (/^[a-z][a-z0-9_:-]{0,63}$/.test(value)) return value;
  if (/fetch|network|abort/i.test(value)) return 'offline';
  return error instanceof Error && /^[A-Za-z]+Error$/.test(error.name)
    ? `operation_${error.name.toLowerCase()}` : 'operation_failed';
}
