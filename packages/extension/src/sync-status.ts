import { t } from './i18n.js';
import type { PublicAuthState } from './types.js';

export type SyncStatusKind = 'signed-out' | 'saved-locally' | 'local-only' | 'setup-required'
  | 'paused' | 'syncing' | 'synced' | 'waiting-network' | 'retrying' | 'action-required' | 'review-conflicts';
export type SyncTone = 'ok' | 'busy' | 'attention' | 'setup' | 'signin';
export interface SyncStatus { readonly kind: SyncStatusKind; readonly label: string; readonly tone: SyncTone }
const tones: Readonly<Record<SyncStatusKind, SyncTone>> = {
  'signed-out': 'signin', 'saved-locally': 'ok', 'local-only': 'setup', 'setup-required': 'setup',
  paused: 'setup', syncing: 'busy', synced: 'ok', 'waiting-network': 'busy', retrying: 'busy',
  'action-required': 'attention', 'review-conflicts': 'attention',
};
/** Only this presentation layer turns stable state identity into localized copy and color. */
export function projectSyncStatus(kind: SyncStatusKind): SyncStatus {
  const labels: Record<SyncStatusKind, string> = {
    'signed-out': t('sync_notSignedIn', 'Not signed in'),
    'saved-locally': t('save_savedBrowser', 'Saved to this browser'),
    'local-only': t('sync_stayLocal', 'No Know-N sync'),
    'setup-required': t('sync_notSynced', 'Sync is off'),
    paused: t('sync_personalPaused', 'Sync is paused'),
    syncing: t('common_syncing', 'Syncing'), synced: t('common_synced', 'Synced'),
    'waiting-network': t('sync_waitingNetwork', 'Waiting for network'),
    retrying: t('sync_errorRetrying', 'Sync error, retrying'),
    'action-required': t('sync_actionRequired', 'Action required'),
    'review-conflicts': t('sync_reviewConflicts', 'Review conflicts'),
  };
  return { kind, label: labels[kind], tone: tones[kind] };
}
export function syncTone(kind: SyncStatusKind, status: PublicAuthState['status']): SyncTone {
  if (status !== 'connected') return status === 'connecting' || status === 'refreshing' ? 'busy' : 'signin';
  return tones[kind];
}
