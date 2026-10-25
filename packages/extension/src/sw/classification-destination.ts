import { createClassificationDestinationPolicy } from '../classification-destination-policy.js';
import { siteLedger } from '../site-adapters/source-runtime.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SourceMount } from '../site-adapters/layout.js';
import { captureDeviceId } from '../capture/device-id.js';
import { managedDestinations } from '../site-adapters/managed-destinations.js';
export const classificationDestinationPolicy = createClassificationDestinationPolicy({
  mounts: () => managedDestinations(siteLedger.db),
  tree: () => chrome.bookmarks.getTree(), deviceId: captureDeviceId,
});
