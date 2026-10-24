import { findSequenceReuseEvidence, sequenceReuseRepairAction } from './sequence-reuse-repair.js';
import { classifyLocalSequenceReuse } from './sequence-reuse-settlement.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

/**
 * `sequence_reuse`/`op_id_reused` means "this client's result is unknown", not
 * "this did not execute". Route it by real identity facts: an illegal proof is
 * a permanent operation failure, existing local authority converges the row to
 * terminal, and the remaining rows stay replayable with growing backoff.
 */
export function createSequenceReuseHandler(input: {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope; readonly ownerId: string;
  readonly persistUnknown: (queue: QueueOperation, fence: number, reason: string, retryAfter: string | null) => Promise<'unknown'>;
}) {
  return async function handleSequenceReuse(queue: QueueOperation, code: 'sequence_reuse' | 'op_id_reused',
    authority: { readonly credential: Pick<StoredCredential, 'subject'>; readonly session: StoredSession },
    fence: number, retryAfter: string | null) {
    const recorded = await input.store.getScope(input.scope);
    const evidence = await findSequenceReuseEvidence(input.store, input.scope, queue);
    const classification = classifyLocalSequenceReuse({ code, scope: input.scope, queue,
      session: authority.session, replicaLifecycle: recorded?.lifecycle ?? 'active',
      hasLocalEvidence: evidence !== null, credentialSubject: authority.credential.subject });
    if (classification === 'illegal') {
      await input.store.settleClaimedPush(input.scope, queue.sequence, input.ownerId, fence,
        { outcome: 'rejected', recovery: { code } });
      return 'rejected' as const;
    }
    // Neither reconcile nor unknown may replay the identical bytes without a
    // strictly increasing backoff. If the immediate convergence below cannot
    // run, the durable unknown row is rescanned by the next drain's repair pass.
    const outcome = await input.persistUnknown(queue, fence, code, retryAfter);
    if (classification === 'reconcile' && evidence) {
      try {
        await input.store.repairSequenceReuseRow(input.scope, queue.sequence,
          sequenceReuseRepairAction(queue, evidence));
        return 'terminal' as const;
      } catch { /* the parked row keeps its evidence and is rescanned next drain */ }
    }
    return outcome;
  };
}
