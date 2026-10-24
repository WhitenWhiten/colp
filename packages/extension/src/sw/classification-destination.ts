import { createClassificationDestinationPolicy } from '../classification-destination-policy.js';
import { siteLedger } from '../site-adapters/source-runtime.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SourceMount } from '../site-adapters/layout.js';
import { captureDeviceId } from './capture-history.js';
export const classificationDestinationPolicy = createClassificationDestinationPolicy({
  mounts: () => siteLedger.db.transaction(['mounts'], 'readonly', tx => cursorPage<SourceMount>(tx.objectStore('mounts'), null, 10001)),
  tree: () => chrome.bookmarks.getTree(), deviceId: captureDeviceId,
});
