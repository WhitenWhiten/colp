export function cooldownIsPending(input: {
  readonly now: number | undefined;
  readonly sessionNotBefore: number | undefined;
  readonly errorCode: string | undefined;
  readonly engineNotBefore: number | undefined;
}): boolean {
  if (!validEpochMilliseconds(input.now) || !validEpochMilliseconds(input.sessionNotBefore)
      || !validEpochMilliseconds(input.engineNotBefore)) return true;
  return input.sessionNotBefore > input.now
    || (input.errorCode !== undefined && input.engineNotBefore > input.now);
}

function validEpochMilliseconds(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Work the push lane can still drain. Held (`set_aside`) rows wait for their problem to clear. */
export function hasRecoverableQueueWork(rows: readonly { readonly status?: string }[]): boolean {
  return rows.some((row) => row.status !== 'terminal' && row.status !== 'rejected' && row.status !== 'set_aside');
}

/**
 * A conflicted push waits for the server's resolution to arrive through Pull,
 * and later changes of the same bookmark are held with it (`conflict_hold`);
 * the rest of the lane keeps syncing. It needs no local recovery, but the UI
 * must be able to say "waiting on a conflict" instead of a vague pending state
 * that never seems to finish.
 */
export function hasConflictBarrier(rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string } }[]): boolean {
  return rows.some((row) => (row.status === 'blocked' && row.recovery?.code === 'conflict_pending')
    || (row.status === 'set_aside' && row.recovery?.code === 'conflict_hold'));
}

export function hasRejectedBarrier(rows: readonly { readonly status?: string }[]): boolean {
  return rows.some((row) => row.status === 'rejected');
}

export function queueStatusProjection(rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string } }[]): 'idle' | 'syncing' | 'conflict' | 'rejected' {
  if (hasConflictBarrier(rows)) return 'conflict';
  if (hasRecoverableQueueWork(rows)) return 'syncing';
  if (hasRejectedBarrier(rows)) return 'rejected';
  return 'idle';
}
