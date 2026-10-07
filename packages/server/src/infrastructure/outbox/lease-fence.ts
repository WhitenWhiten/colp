/**
 * Lock first, then evaluate the wall clock in a separate statement. A WHERE
 * predicate evaluated before waiting for a row lock cannot fence expiry during
 * the wait. Caller must hold this transaction through its commit/rollback.
 */
export async function fenceOutboxLease(
  execute: (statement: string, parameters: unknown[]) => Promise<{ rows: readonly { owned?: boolean }[] }>,
  attempt: { readonly outboxId: string; readonly leaseGeneration: string },
  signal: AbortSignal,
): Promise<boolean> {
  await execute('select outbox_id from outbox_events where outbox_id=$1 for update', [attempt.outboxId]);
  signal.throwIfAborted();
  const result = await execute(`select state='leased' and lease_generation=$2
    and locked_until > clock_timestamp() as owned from outbox_events where outbox_id=$1`,
  [attempt.outboxId, attempt.leaseGeneration]);
  signal.throwIfAborted();
  return result.rows[0]?.owned === true;
}
