import { createSourceLayout } from './layout.js';
import { siteLedger } from './source-runtime.js';
import { currentFlat, nativeFolderLookup } from '../sw/automation-browser.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertPlannedNative } from '../sw/planned-capture.js';
import { installSourcePlanAuthorization } from './planned-runtime.js';

export const sourceLayout = createSourceLayout(siteLedger.db, {
  rules: currentFlat, paused: sourceAutomationsPaused, deviceId: captureDeviceId,
  lookup: nativeFolderLookup, assertRoot: assertPlannedNative,
});
export function installSourceLayout() {
  installSourcePlanAuthorization((plan, effect) => sourceLayout.authorize(plan, effect));
  let listening = false;
  const listen = () => {
    if (listening || !chrome.bookmarks) return;
    listening = true;
    chrome.bookmarks.onChanged.addListener(id => { void sourceLayout.nativeChanged([id], false).catch(() => undefined); });
    chrome.bookmarks.onMoved.addListener(id => { void sourceLayout.nativeChanged([id], false).catch(() => undefined); });
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
