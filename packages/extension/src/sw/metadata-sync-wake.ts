import { listenToWorkerAnnotationChanges } from '../bookmark-annotation-notice.js';
import { listenToWorkerFolderDescriptionChanges } from '../folder-description-native.js';
import { scheduleSyncEngineWake } from './engine.js';
import { workCoordinator } from './runtime.js';

let pending: Promise<void> | undefined;

/** One wake after the local-bookmark work in progress; edits made meanwhile share it. */
function wakeAfterLocalWork(): void {
  pending ??= workCoordinator.run('local-bookmark', async () => undefined).then(() => {
    pending = undefined;
    void scheduleSyncEngineWake('manual').catch(() => undefined);
  }, () => { pending = undefined; });
}

/**
 * Tags, notes, pins and folder descriptions the worker writes itself (pin requests,
 * capture results, restores, delete undo) wake sync like a page's edit does. The wake
 * waits for the local-bookmark work in progress, so a pin is placed before sync takes
 * the native order.
 */
export function installWorkerMetadataWake(): void {
  listenToWorkerAnnotationChanges(wakeAfterLocalWork);
  listenToWorkerFolderDescriptionChanges(wakeAfterLocalWork);
}
