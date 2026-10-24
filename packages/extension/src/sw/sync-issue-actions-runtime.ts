import { createQueueRecapture } from '../queue-recapture.js';
import { scheduleSyncEngineWake } from './engine.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope } from './scope.js';
import type { SyncIssueActionDeps } from './sync-issue-actions.js';

/**
 * Production wiring for Try again and Dismiss on the Status card: queue changes run in the engine's lane,
 * exactly where the Sync center's own Retry for an item runs them, and a released item starts a manual pass.
 */
export const syncIssueActionDeps: SyncIssueActionDeps = {
  scope: currentSyncScope, store: syncState,
  run: work => workCoordinator.run('engine', () => work()),
  recapture: scope => createQueueRecapture({ store: syncState, scope, api: chrome.bookmarks, permission: hasBookmarkPermission }),
  wake: () => scheduleSyncEngineWake('manual'),
};
