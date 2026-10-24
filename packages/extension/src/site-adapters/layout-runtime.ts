import { createSourceLayout } from './layout.js';
import { siteLedger } from './source-runtime.js';
import { currentFlat, nativeFolderLookup } from '../sw/automation-browser.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertPlannedNative } from '../sw/planned-capture.js';
import { installSourcePlanAuthorization } from './planned-runtime.js';
import { contentBindings, isManagedContentMove } from './content-runtime.js';
import { captureStore } from '../sw/capture.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { workCoordinator } from '../sw/runtime.js';
import { unsettledCloudDestination } from '../classification-destination-boundary.js';

export const sourceLayout = createSourceLayout(siteLedger.db, {
  rules: currentFlat, paused: sourceAutomationsPaused, deviceId: captureDeviceId,
  lookup: nativeFolderLookup, assertRoot: assertPlannedNative,
  sourceCopies: input => contentBindings.sourceDecision(input),
  async beforeExclusion() {
    if (workCoordinator.hasInFlight('classification')) throw new Error('cloudClassificationPending');
    const scope = await currentCaptureScope(); let before: readonly [number, string] | undefined;
    for (;;) {
      const page = await captureStore.listForOwner(scope, before);
      if (page.some(unsettledCloudDestination)) throw new Error('cloudClassificationPending');
      const last = page.at(-1); if (!last || page.length < 50) break; before = [last.createdAt, last.captureId];
    }
  },
});
export function installSourceLayout() {
  installSourcePlanAuthorization((plan, effect) => sourceLayout.authorize(plan, effect));
  let listening = false;
  const listen = () => {
    if (listening || !chrome.bookmarks) return;
    listening = true;
    chrome.bookmarks.onChanged.addListener(id => { void sourceLayout.nativeChanged([id], false).catch(() => undefined); });
    chrome.bookmarks.onMoved.addListener((id, info) => { void (async () => {
      if (!await isManagedContentMove(id, info.parentId, info.oldParentId)) await sourceLayout.nativeChanged([id], false);
    })().catch(() => undefined); });
    chrome.bookmarks.onRemoved.addListener((id, info) => {
    const ids = [id];
    const add = (n: chrome.bookmarks.BookmarkTreeNode) => { ids.push(n.id); for (const child of n.children ?? []) add(child); };
    if (info.node) add(info.node);
    void sourceLayout.nativeChanged(ids, true).catch(() => undefined);
    });
  };
  listen();
  chrome.permissions.onAdded.addListener(listen);
}
