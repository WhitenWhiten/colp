/**
 * Shared AbortSignal race for PostgreSQL statements (FIX-L-015).
 *
 * When `signal` aborts while a statement is in flight, the caller's `cancel`
 * is invoked — for the Publication readers that is the runtime's controlled
 * `pg_cancel_backend` for the exact backend PID — and the operation is left to
 * settle in the background (its rejection is always handled, so no unhandled
 * rejection is possible). The caller rejects with `signal.reason`, so request
 * cancellation never masquerades as a database failure (query_canceled /
 * 57014) and never looks like a cache failure. Without a signal the operation
 * runs untouched with zero extra round trips.
 */
import type { PoolClient } from 'pg';
import { observeBestEffort, settleBestEffort } from '../async/best-effort.js';

export async function withPostgresAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  cancel: () => Promise<void>,
): Promise<Value> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    // A pre-aborted signal rejects fast, but the statement promise must stay
    // observed so a late rejection can never become an unhandled rejection.
    observeBestEffort(operation,
      'the pre-aborted signal is authoritative over a late query rejection');
    throw signal.reason;
  }
  const completed = operation.then(
    (value) => ({ completed: true as const, value }),
    (error: unknown) => ({ completed: true as const, error }),
  );
  // Definite-assignment assertion for the resolver that the race awaits.
  let notifyAbort!: () => void;
  const aborted = new Promise<{ readonly completed: false }>((resolve) => {
    notifyAbort = () => resolve({ completed: false });
    signal.addEventListener('abort', notifyAbort, { once: true });
  });
  const outcome = await Promise.race([completed, aborted]);
  signal.removeEventListener('abort', notifyAbort);
  if (outcome.completed) {
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
  await settleBestEffort(cancel(),
    'the aborted request result is authoritative over cancellation transport failure');
  await settleBestEffort(operation,
    'the AbortSignal reason is authoritative over the cancelled query rejection');
  throw reason;
}

/**
 * Reads the exact backend PID of a checked-out client (FIX-L-015), the
 * cancellation target for the runtime's controlled `pg_cancel_backend`.
 * Without a signal no round trip is issued and `undefined` is returned (the
 * no-signal path stays byte-identical to a plain statement run).
 */
export async function readBackendPid(
  client: PoolClient,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  if (signal === undefined) return undefined;
  const backend = await withPostgresAbort(
    client.query<{ pid: number }>('select pg_backend_pid() as pid'),
    signal,
    () => Promise.resolve(),
  );
  const pid = backend.rows[0]?.pid;
  return pid === undefined || !Number.isSafeInteger(pid) || pid < 1 ? undefined : pid;
}
