import { classifySyncFailure } from './sync-failure-class.js';
import { readOpenSyncIssues } from './sync-issues.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

export const OPEN_SYNC_ISSUE_CEILING = 200;
export const SYNC_ISSUE_CEILING_CODE = 'sync_issue_ceiling';
type Store = ReturnType<typeof createSyncStateStore>;
export async function exceedsSyncIssueCeiling(store: Store, scope: SyncScope): Promise<boolean> {
  return (await readOpenSyncIssues(store, scope)).total > OPEN_SYNC_ISSUE_CEILING;
}

/** Admission stop, not stream corruption: never retire pages or erase native recovery ownership. */
export async function enforceSyncIssueCeiling(store: Store, scope: SyncScope, now = Date.now()): Promise<boolean> {
  if (!await exceedsSyncIssueCeiling(store, scope)) return false;
  const prior = await store.getEngineState(scope);
  const policy = classifySyncFailure(prior?.lastError);
  if (prior?.lastError !== SYNC_ISSUE_CEILING_CODE && prior?.recoveryFrozen
      && policy?.class === 'replica' && (policy.exit === 'rebuild' || policy.exit === 'stop')) return true;
  if (prior?.lastError === SYNC_ISSUE_CEILING_CODE && prior.phase === 'error' && prior.recoveryFrozen) return true;
  await store.transitionEngine(scope, { ...prior, phase: 'error', recoveryFrozen: true,
    authorityRefreshRequired: prior?.authorityRefreshRequired ?? false, lastError: SYNC_ISSUE_CEILING_CODE,
    updatedAt: now, notBefore: 0, ...(prior ? { expectedRevision: prior.revision } : {}) });
  return true;
}
