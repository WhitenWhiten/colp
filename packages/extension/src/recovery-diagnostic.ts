import type { createSyncStateStore, SyncScope } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'putScopeDiagnostic'>;

/** Diagnostics must not break recovery, but failed persistence must remain observable. */
export async function recordRecoveryDiagnostic(store: Store, scope: SyncScope,
  kind: 'bookmark_event_recovery' | 'idle_compaction', code: string): Promise<void> {
  try { await store.putScopeDiagnostic(scope, { kind, code }); }
  catch { console.warn('sync_recovery_diagnostic_unavailable', kind); }
}
