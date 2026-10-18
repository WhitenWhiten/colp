import type { RecaptureQueueRow } from './queue-recapture.js';
import { reasonCode } from './push-error-code.js';
import type { ParsedPushResult } from './sync-push-wire.js';
import type { JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

export async function settlePushResult(input: {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly ownerId: string; readonly fence: number; readonly now: () => number; readonly random: () => number;
  readonly schedule?: (delay: number) => void; readonly settlementFault?: 'after_receipt';
  readonly onTerminal?: (queue: QueueOperation) => Promise<void>;
  readonly digestJson: (value: unknown) => string;
  readonly retryDelay: (attempt: number, seconds: number | undefined, header: string | null,
    now: number, random: () => number) => number;
  readonly authoritativeCreate: (queue: QueueOperation, targetId: string, revision: string) =>
    Promise<{ nativeId: string; targetId: string; revision: string } | undefined>;
  readonly bindSpecialRoleMount: (queue: QueueOperation, targetId: string, revision: string) => Promise<void>;
}, queue: QueueOperation, parsed: ParsedPushResult): Promise<'terminal' | 'blocked' | 'deferred'> {
  const resultDigest = input.digestJson(parsed.document); const receipt = { opId: queue.opId,
    operationDigest: queue.digest, kind: parsed.terminal ? 'terminal' as const : 'deferred' as const,
    receiptId: `push-${queue.opId}`, resultDigest, result: parsed.document as JsonObject };
  if (parsed.result.status === 'conflicted') {
    await input.store.settleClaimedPush(input.scope, queue.sequence, input.ownerId, input.fence, { outcome: 'blocked',
      receipt, retry: { attempt: queue.retry.attempt, notBefore: input.now() }, recovery: { code: 'conflict_pending' } },
    input.settlementFault ? { fault: input.settlementFault } : undefined);
    return 'blocked';
  }
  if (!parsed.terminal) {
    const delay = input.retryDelay(queue.retry.attempt + 1, parsed.result.retryAfterSeconds, null, input.now(), input.random);
    await input.store.settleClaimedPush(input.scope, queue.sequence, input.ownerId, input.fence, { outcome: 'deferred',
      receipt, retry: { attempt: queue.retry.attempt + 1, notBefore: input.now() + delay } });
    input.schedule?.(delay); return 'deferred';
  }
  const successfulCreate = queue.payload.type === 'create_node'
    && (parsed.result.status === 'applied' || parsed.result.status === 'rebased');
  if (successfulCreate && (typeof parsed.result.targetId !== 'string'
      || typeof parsed.result.revision !== 'string')) throw new Error('authoritative_create_result_invalid');
  const create = successfulCreate
    ? await input.authoritativeCreate(queue, parsed.result.targetId!, parsed.result.revision!) : undefined;
  const mergedTransform = queue.payload.type === 'update_node_content'
    && (parsed.result.status === 'applied' || parsed.result.status === 'rebased')
    && parsed.result.transform && typeof parsed.result.transform === 'object'
    && !Array.isArray(parsed.result.transform) ? parsed.result.transform as JsonObject : undefined;
  let projection = (queue.payload.type === 'update_node_content' || queue.payload.type === 'move_node')
    && (parsed.result.status === 'applied' || parsed.result.status === 'rebased')
    && typeof queue.payload.targetId === 'string' && typeof parsed.result.revision === 'string'
    ? { targetId: queue.payload.targetId, revision: parsed.result.revision,
      ...(mergedTransform ? { content: mergedTransform } : {}) } : undefined;
  if (projection) {
    const mapped = (await input.store.getMappingByColpId(input.scope, projection.targetId))
      ?.projection.revision;
    if (!mapped || (mapped !== queue.operationRevision && mapped !== queue.baseRevision
      && mapped !== projection.revision)) projection = undefined;
  }
  await input.store.settleClaimedPush(input.scope, queue.sequence, input.ownerId, input.fence, { outcome: 'terminal',
    receipt, ...(create ? { authoritativeCreate: create } : {}),
    ...(projection ? { authoritativeProjection: projection } : {}) },
  input.settlementFault ? { fault: input.settlementFault } : undefined);
  if (successfulCreate) {
    try { await input.bindSpecialRoleMount(queue, parsed.result.targetId!, parsed.result.revision!); }
    catch { /* Applied already; bind races must not downgrade the receipt to unknown. */ }
  }
  try { await input.onTerminal?.(queue); } catch { /* startup recovery resumes the durable event inbox */ }
  return 'terminal';
}

/**
 * Returns the changes held behind a conflict or a held item that is now
 * settled to the push lane. A failed pass keeps them held for the next drain,
 * but is journaled and counted as attention so a stuck hold is
 * distinguishable from "nothing to release".
 */
export async function releaseSettledQueueHolds(store: ReturnType<typeof createSyncStateStore>,
  scope: SyncScope, recapture?: RecaptureQueueRow): Promise<number> {
  try {
    await store.releaseSettledHolds(scope, recapture); return 0;
  } catch (error) {
    try { await store.putScopeDiagnostic(scope, { kind: 'conflict_hold_release',
      code: reasonCode(error, 'conflict_hold_release_failed') }); } catch { /* best effort */ }
    return 1;
  }
}
