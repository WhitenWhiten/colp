import { requirePromise } from './internal-guards.js';
import type { ReplicaLifecycleKey } from './replica-lifecycle.js';
import { SyncSessionGateDeniedError, type VerifiedSyncSession } from './session.js';

/**
 * Proves the durable principal/tenant/credential binding for a Push Replica.
 * Runs before receipt lookup or any UnitOfWork, including exact replays.
 * Return true only when the verified Session is authorized to use this Replica.
 */
export type PushReplicaOwnershipVerifier = (
  session: VerifiedSyncSession,
  key: Readonly<ReplicaLifecycleKey>,
) => boolean | Promise<boolean>;

export async function assertPushReplicaOwnership(
  verifier: PushReplicaOwnershipVerifier | undefined,
  session: VerifiedSyncSession,
  key: ReplicaLifecycleKey,
): Promise<void> {
  if (verifier === undefined) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Push requires a pushOwnershipVerifier proving the Replica belongs to the Session principal.',
    });
  }
  if (typeof verifier !== 'function') throw new TypeError('Push ownership verifier must be a function.');
  const candidate = verifier(session, Object.freeze({ ...key }));
  const verdict = candidate instanceof Promise
    ? await requirePromise(candidate, 'Push ownership verifier') : candidate;
  if (verdict === false) {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail: 'Push Replica does not belong to the verified Session principal.',
    });
  }
  if (verdict !== true) throw new TypeError('Push ownership verifier must return a boolean.');
}
