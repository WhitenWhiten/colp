import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { syncState } from './runtime.js';
import { createSyncWatchdog, type SyncWatchdog } from './sync-watchdog.js';

let instance: SyncWatchdog | undefined;

/**
 * The worker's watchdog: this extension's own storage, push queue and personal
 * sync policy. Created on first use, so importing it costs nothing and a page
 * that never asks never touches session storage.
 */
export const syncWatchdog: SyncWatchdog = {
  sample: input => (instance ??= createSyncWatchdog({
    local: chrome.storage.local, session: chrome.storage.session,
    head: scope => syncState.firstLaneQueue(scope),
    mode: async scope => (await configuredPersonalSyncPolicy()?.read(scope))?.mode,
  })).sample(input),
};
