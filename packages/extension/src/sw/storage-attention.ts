import { stableError } from '../durable-sync-engine-errors.js';
import { readReplicaRepairCapability } from '../replica-repair-capability.js';
import type { SyncScope } from '../sync-state-store.js';
import type { SyncStorageHealth } from '../sync-state/storage-state.js';
import type { PublicSyncAttention, SyncAttentionResponse } from '../types.js';

/**
 * W2A-01: what Status answers when the sync database cannot be used.
 *
 * Every read of the store failed, so Status said "state unavailable" and the popup, which could not tell
 * that from "nothing set up", offered the first-sync card. This is a readable answer instead: the code that
 * names the cause (`lastError`), the state in words the UI can switch on, and the one exit that works,
 * a confirmed reset of the local sync data. A transient failure (the browser's storage hiccuping, a full
 * disk) retries by itself; the others wait for the person.
 */
export function storageAttention(health: SyncStorageHealth): PublicSyncAttention | undefined {
  if (health.state === 'ok') return undefined;
  const code = health.code ?? 'storage_unavailable';
  const transient = health.state === 'unavailable';
  return {
    phase: 'error', recoveryFrozen: false, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
    nativeWaitPending: false, waitCount: 0, retryAutomatic: transient, retryAvailable: transient,
    issueCount: 1, issues: [{ direction: 'local', code, rootCause: health.state }],
    rebuildAvailable: false, rebuildUnavailableReason: 'storage_unavailable',
    lastError: code, terminal: !transient,
    storageState: health.state, storageResetAvailable: true,
  };
}

/**
 * The storage answer, if the store is unusable. A plain `not_connected` is not a storage problem; any other
 * failure of reading the scope or the store is probed once and, when the database is fine, left to the caller.
 */
export async function readStorageAttention(store: { storageState?: () => Promise<SyncStorageHealth> },
  cause?: unknown): Promise<SyncAttentionResponse | undefined> {
  if (cause instanceof Error && cause.message === 'not_connected') return undefined;
  const health = await store.storageState?.().catch((): undefined => undefined);
  const attention = health && storageAttention(health);
  return attention ? { ok: true, attention } : undefined;
}

/**
 * B-09: the database opens but some record in it cannot be read, so the status read failed as a whole and
 * the card (and the Reset it offers) disappeared. Say so instead: the code that failed, and what a Reset can
 * do from here. Only when the repair capability confirms the state is unreadable; a read that failed once and
 * works again is left to the caller.
 */
export async function unreadableStateAttention(store: Parameters<typeof readReplicaRepairCapability>[0]
  & { getScope(scope: SyncScope): Promise<unknown> }, scope: SyncScope, cause: unknown): Promise<SyncAttentionResponse | undefined> {
  // A scope that was never registered (signed in, sync not set up yet) has nothing to read: that is setup, not damage.
  const recorded = await store.getScope(scope).then((value): unknown => value ?? undefined, (): unknown => 'unreadable');
  if (recorded === undefined) return undefined;
  const capability = await readReplicaRepairCapability(store, scope);
  if (!capability.unreadable) return undefined;
  const code = stableError(cause);
  return { ok: true, attention: {
    phase: 'error', recoveryFrozen: false, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
    nativeWaitPending: false, waitCount: 0, retryAutomatic: false, retryAvailable: true,
    issueCount: 1, issues: [{ direction: 'local', code, rootCause: 'state_unreadable' }],
    rebuildAvailable: capability.rebuildAvailable, rebuildMode: capability.rebuildMode,
    ...(capability.rebuildBlockedReason ? { rebuildBlockedReason: capability.rebuildBlockedReason } : {}),
    ...(capability.reason ? { rebuildUnavailableReason: capability.reason } : {}),
    lastError: code, terminal: false } };
}

/**
 * W2A-01: what the Sync center is told when the database cannot be used: the cause, not "diagnostics
 * unavailable", and no Rebuild (it needs the very database that cannot be read). Undefined while it works.
 */
export async function storageStopProjection(store: { storageState?: () => Promise<SyncStorageHealth> }) {
  const health = await store.storageState?.().catch((): undefined => undefined);
  if (!health || health.state === 'ok') return undefined;
  return { state: 'stopped' as const, code: health.code ?? 'storage_unavailable',
    issues: { total: 0, items: [] as never[] }, actions: [] as never[] };
}
