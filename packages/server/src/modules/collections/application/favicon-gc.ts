/**
 * FO-02 favicon object GC (application policy + orchestration).
 *
 * Objects leave live reference when a refresh CAS switches the binding. The
 * exit is recorded durably with `deletable_at = retired_at +
 * FAVICON_HISTORY_RETENTION_SECONDS`, so the promised immutable cache window
 * is never undercut. The GC loop then:
 *
 *   1. claims only records whose retention window has passed (lease + SKIP
 *      LOCKED, so duplicate consumption is impossible);
 *   2. rechecks references immediately before deleting: a current binding or
 *      an in-flight job that still holds the object id blocks collection
 *      (current / non-expired history / future force-restore references are
 *      never collected);
 *   3. deletes through the object store and clears the record; a delete
 *      failure schedules a backoff retry instead of dropping the record.
 */
import type { FaviconJobErrorReason } from './favicon-job.js';
import {
  FAVICON_GC_MAX_ATTEMPTS,
  nextFaviconGcAttemptAt,
  type FaviconPendingDeletionRecord,
} from './favicon-job-execution.js';

export interface FaviconGcClaim {
  readonly objectId: string;
  readonly leaseOwner: string;
  readonly nodeId: string;
  readonly collectionId: string;
  readonly deletableAt: Date;
  readonly attempts: number;
}

export interface FaviconGcStorePort {
  delete(objectId: string): Promise<void>;
}

export interface FaviconGcWorkerRepository {
  /** Current-binding + in-flight-job reference recheck. */
  isObjectReferenced(objectId: string): Promise<boolean>;
  markDeleted(input: { readonly objectId: string; readonly leaseOwner: string }): Promise<boolean>;
  scheduleRetry(input: {
    readonly objectId: string;
    readonly leaseOwner: string;
    readonly attempts: number;
    readonly lastError: string;
    readonly nextAttemptAt: Date;
  }): Promise<boolean>;
}

export interface FaviconGcExecutionPorts {
  readonly store: FaviconGcStorePort;
  readonly repository: FaviconGcWorkerRepository;
  readonly backoffSeconds: readonly number[];
  readonly now: () => Date;
}

export type FaviconGcOutcome = 'deleted' | 'retry_scheduled' | 'reference_held' | 'lease_lost';

export interface FaviconGcResult {
  readonly objectId: string;
  readonly outcome: FaviconGcOutcome;
}

/** Stable, non-secret reason recorded for a failed GC attempt. */
export function faviconGcFailureLabel(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0 && name !== 'Error') return name.slice(0, 64);
  }
  return 'storage_delete_failed';
}

/**
 * Process one claimed pending deletion. Never throws for expected storage
 * failures: a failed delete keeps the durable record with a backoff retry.
 */
export async function processFaviconGcClaim(
  ports: FaviconGcExecutionPorts,
  claim: FaviconGcClaim,
): Promise<FaviconGcResult> {
  if (await ports.repository.isObjectReferenced(claim.objectId)) {
    // A current binding or an in-flight job still holds the object. Keep the
    // durable record and recheck later; never delete a referenced object.
    const nextAttemptAt = nextFaviconGcAttemptAt(
      claim.attempts + 1,
      ports.backoffSeconds,
      ports.now(),
    );
    await ports.repository.scheduleRetry({
      objectId: claim.objectId,
      leaseOwner: claim.leaseOwner,
      attempts: Math.min(claim.attempts + 1, FAVICON_GC_MAX_ATTEMPTS),
      lastError: 'object_still_referenced',
      nextAttemptAt,
    });
    return { objectId: claim.objectId, outcome: 'reference_held' };
  }
  try {
    await ports.store.delete(claim.objectId);
  } catch (error) {
    const attempts = claim.attempts + 1;
    const nextAttemptAt = nextFaviconGcAttemptAt(attempts, ports.backoffSeconds, ports.now());
    const written = await ports.repository.scheduleRetry({
      objectId: claim.objectId,
      leaseOwner: claim.leaseOwner,
      attempts: Math.min(attempts, FAVICON_GC_MAX_ATTEMPTS),
      lastError: faviconGcFailureLabel(error),
      nextAttemptAt,
    });
    return { objectId: claim.objectId, outcome: written ? 'retry_scheduled' : 'lease_lost' };
  }
  const deleted = await ports.repository.markDeleted({
    objectId: claim.objectId,
    leaseOwner: claim.leaseOwner,
  });
  return { objectId: claim.objectId, outcome: deleted ? 'deleted' : 'lease_lost' };
}

/** Retention window helper shared by the CAS and tests. */
export function faviconRetirementWindow(
  record: Pick<FaviconPendingDeletionRecord, 'retiredAt' | 'deletableAt'>,
): number {
  return record.deletableAt.getTime() - record.retiredAt.getTime();
}

/** Mapping helper used by observability tests: reason -> retryable label. */
export function faviconGcReasonLabel(reason: FaviconJobErrorReason): string {
  return reason;
}