import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';

import { browserHistoryStore } from '../capture/browser-history-store.js';
import { createBookmarkCreatePlacementStore, BOOKMARK_CREATE_RECEIPT_KEY_PREFIX, parseBookmarkCreatePlacementRecord } from '../bookmark-create-placement.js';
import { createFaviconSidecarStore } from '../favicon-sidecar-store.js';
import { savePagesThroughNativeIngress } from '../save-entry.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { queryCaptureExistence } from '../capture/existence.js';
import { sameCaptureScope, captureOwnerKey, type CaptureLocation, type CaptureScope, type CaptureTask } from '../capture/contracts.js';
import type { CaptureReceipt } from '../capture/coordinator.js';
import { hasBookmarkPermission, store, syncState } from './runtime.js';
import { boundCollectionId, currentSyncScope, loadConfig } from './scope.js';
import { handleSaveStatus } from './save-status.js';
import { assertBookmarkFolderAllowed, isUnsupportedBookmarkFolder } from '../bookmark-folder-policy.js';

export async function currentCaptureScope(): Promise<CaptureScope> {
  const [config, credential, authority, collectionId] = await Promise.all([
    loadConfig(), store.loadCredential(), store.fence.read(), boundCollectionId(),
  ]);
  const accountId = credential?.serverOrigin === config.serverOrigin ? credential.subject ?? null : null;
  return { serverOrigin: config.serverOrigin, accountId, authorityGeneration: authority.generation,
    collectionId: accountId ? collectionId : null };
}
export async function assertCaptureScope(scope: CaptureScope): Promise<void> {
  if (!sameCaptureScope(scope, await currentCaptureScope())) throw new Error('capture_scope_changed');
}
export async function assertCaptureOwner(scope: CaptureScope): Promise<void> {
  if (captureOwnerKey(scope) !== captureOwnerKey(await currentCaptureScope())) throw new Error('capture_scope_changed');
}

export async function nativeCaptureLocation(nativeId: string, scope: CaptureScope): Promise<CaptureLocation> {
  await assertCaptureOwner(scope);
  await assertBookmarkFolderAllowed(nativeId);
  if(await isSubscriptionExcluded(nativeId))throw new Error('subscription_capture_excluded');
  const node = (await chrome.bookmarks.get(nativeId))[0];
  if (!node?.url) throw new Error('capture_native_missing');
  const path: string[] = [];
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = (await chrome.bookmarks.get(parentId))[0];
    if (!parent) break;
    if (parent.title) path.unshift(parent.title);
    parentId = parent.parentId;
  }
  const syncScope = await currentSyncScope().catch(() => null);
  const mapping = syncScope && scope.accountId === syncScope.accountId && scope.collectionId === syncScope.collectionId
    ? await syncState.getMappingByNativeId(syncScope, nativeId) : null;
  await assertCaptureOwner(scope);
  return { nativeId, nodeId: mapping?.colpId ?? null, collectionId: mapping ? scope.collectionId : null,
    collectionTitle: null, path, writable: !node.unmodifiable, url: node.url };
}

export async function captureExistence(task: Pick<CaptureTask, 'url' | 'scope'>) {
  return queryCaptureExistence(task.url, {
    now: Date.now,
    async local(url) {
      if (!await hasBookmarkPermission()) throw new Error('permission_required');
      const matches = await chrome.bookmarks.search({ url });
      const eligible=[];for(const node of matches)if(!await isSubscriptionExcluded(node.id)&&!await isUnsupportedBookmarkFolder(node.id))eligible.push(node);
      return Promise.all(eligible.map(node => nativeCaptureLocation(node.id, task.scope)));
    },
  });
}

async function receiptFor(nativeId: string, scope: CaptureScope, savedAt?: number): Promise<CaptureReceipt> {
  const location = await nativeCaptureLocation(nativeId, scope);
  const status = await handleSaveStatus(nativeId);
  const sync = status.ok && status.localOnly ? 'local-only' : 'pending';
  return { nativeId, location, sync, ...(savedAt === undefined ? {} : { savedAt }) };
}

export async function createNativeCapture(task: CaptureTask, reserved: (intentId: string) => Promise<void>, saved: (receipt: CaptureReceipt) => Promise<void>): Promise<CaptureReceipt> {
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  const placementStore = createBookmarkCreatePlacementStore({ retainForConsumer: true });
  const sidecar = createFaviconSidecarStore();
  try {
    const result = await savePagesThroughNativeIngress({ pages: [{ title: task.title, url: task.url, favIconUrl: task.favIconUrl }],
      parentNativeId: task.targetNativeId, insertPosition: task.insertPosition,
      foldersFirst: (await readEffectiveBookmarkPreferences().catch(() => undefined))?.foldersFirst === true,
      ...(task.resumeNativeIds ? { resumeNativeIds: task.resumeNativeIds } : {}),
      ...(task.scope.collectionId && task.sync !== 'local-only' ? { collectionId: task.scope.collectionId } : {}),
      placementStore, sidecar, bookmarks: {
        getChildren: id => chrome.bookmarks.getChildren(id),
        async create(input) { await assertCaptureScope(task.scope); await assertBookmarkFolderAllowed(input.parentId); return chrome.bookmarks.create(input); /* savePagesThroughNativeIngress holds the shared boundary. */ },
      }, onPlacementReserved: intent => reserved(intent.intentId),
      onNativeCreated: async node => {
        // The native write already succeeded. Its device fact does not depend on
        // a still-current cloud account and never carries that account's commands.
        const savedAt = Date.now();
        await browserHistoryStore.remember({ ...task, savedAt }, node.id).catch(() => undefined);
        await saved(await receiptFor(node.id, task.scope, savedAt));
      },
    });
    if (!result[0]) throw new Error('capture_missing_receipt');
    return await receiptFor(result[0].nativeId, task.scope);
  } finally { sidecar.close(); }
}

export async function recoverNativeCapture(task: CaptureTask): Promise<CaptureReceipt | null> {
  if (!task.nativeIntentId) return null;
  const reservation = await createBookmarkCreatePlacementStore().get(task.nativeIntentId);
  const key = `${BOOKMARK_CREATE_RECEIPT_KEY_PREFIX}${task.nativeIntentId}`;
  const receipt = parseBookmarkCreatePlacementRecord((await chrome.storage.local.get(key))[key]);
  const proof = receipt ?? reservation;
  if (proof?.state !== 'bound' || !proof.nativeId) return null;
  // No URL guessing, no new native create, even after the placement recovery TTL.
  // Recovery reuses the native write's time, never the time of this retry.
  const native = (await chrome.bookmarks.get(proof.nativeId).catch(() => []))[0];
  const savedAt = task.savedAt ?? native?.dateAdded ?? proof.createdAt;
  await browserHistoryStore.remember({ ...task, savedAt }, proof.nativeId).catch(() => undefined);
  return receiptFor(proof.nativeId, task.scope, savedAt).catch(() => null);
}
