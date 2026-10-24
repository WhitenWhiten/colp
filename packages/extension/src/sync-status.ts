import { t } from './i18n.js';
import type { PublicAuthState, PublicSyncAttention } from './types.js';

export type SyncStatusKind = 'signed-out' | 'saved-locally' | 'local-only' | 'setup-required'
  | 'paused' | 'syncing' | 'synced' | 'waiting-network' | 'retrying' | 'action-required' | 'review-conflicts'
  | 'permission-required' | 'stuck' | 'status-unavailable';
export type SyncTone = 'ok' | 'busy' | 'attention' | 'setup' | 'signin';
export interface SyncStatus { readonly kind: SyncStatusKind; readonly label: string; readonly tone: SyncTone }
const tones: Readonly<Record<SyncStatusKind, SyncTone>> = {
  'signed-out': 'signin', 'saved-locally': 'ok', 'local-only': 'setup', 'setup-required': 'setup',
  paused: 'setup', syncing: 'busy', synced: 'ok', 'waiting-network': 'busy', retrying: 'busy',
  'action-required': 'attention', 'review-conflicts': 'attention',
  'permission-required': 'attention', stuck: 'attention', 'status-unavailable': 'attention',
};
/** Only this presentation layer turns stable state identity into localized copy and color. */
export function projectSyncStatus(kind: SyncStatusKind): SyncStatus {
  const labels: Record<SyncStatusKind, string> = {
    'signed-out': t('sync_notSignedIn', 'Not signed in'),
    'saved-locally': t('save_savedBrowser', 'Saved to this browser'),
    'local-only': t('sync_stayLocal', 'This browser only'),
    'setup-required': t('sync_notSynced', 'Sync is off'),
    paused: t('sync_personalPaused', 'Sync is paused'),
    syncing: t('common_syncing', 'Syncing'), synced: t('common_synced', 'Synced'),
    'waiting-network': t('sync_waitingNetwork', 'Waiting for network'),
    retrying: t('sync_errorRetrying', 'Sync error, retrying'),
    'action-required': t('sync_actionRequired', 'Action required'),
    'review-conflicts': t('sync_reviewConflicts', 'Review conflicts'),
    'permission-required': t('sync_permissionRequired', 'Bookmark access needed'),
    stuck: t('sync_stuck', 'Sync is stuck'),
    'status-unavailable': t('sync_statusUnavailable', 'Can’t read sync status'),
  };
  return { kind, label: labels[kind], tone: tones[kind] };
}
export function syncTone(kind: SyncStatusKind, status: PublicAuthState['status']): SyncTone {
  if (status !== 'connected') return status === 'connecting' || status === 'refreshing' ? 'busy' : 'signin';
  return tones[kind];
}

/**
 * What the attention facts alone say about the chip, in the order that matters
 * to a person: a conflict, access the extension lost, then anything that waits
 * for them. A pause the engine ends by itself (`coolingDown`) is a retry, not a
 * stop, and an item that clears by itself (`recovery: 'automatic'`) is not a
 * decision. `undefined`: nothing here, so the engine's own phase decides.
 */
export function attentionStatusKind(facts: PublicSyncAttention): SyncStatusKind | undefined {
  if (facts.conflictPending) return 'review-conflicts';
  if (facts.permissionRequired) return 'permission-required';
  const automatic = facts.issues?.filter(issue => issue.recovery === 'automatic').length ?? 0;
  if ((facts.issueCount ?? 0) - automatic > 0 || facts.terminal || facts.rejectedPending || facts.nativeWaitPending
      || (facts.retryAutomatic === false && facts.coolingDown !== true)) return 'action-required';
  return facts.coolingDown === true ? 'retrying' : undefined;
}
