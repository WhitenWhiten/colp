/**
 * Shared AbortSignal race for PostgreSQL statements (FIX-L-015).
 *
 * When `signal` aborts while a statement is in flight, the caller's `cancel`
 * is invoked — for the Publication readers that is the runtime's controlled
 * `pg_cancel_backend` for the exact backend PID — and the cancellation attempt
 * is awaited while the statement itself is left to settle in the background
 * (its rejection is always handled, so no unhandled rejection is possible).
 * Waiting for the aborted statement would hold the caller's request until the
 * backend observes the cancel or hits `statement_timeout`, so it is deliberately
 * not awaited: a cancel that reports failure (`false`) still returns the signal
 * reason immediately. The caller rejects with `signal.reason`, so request
 * cancellation never masquerades as a database failure (query_canceled /
 * 57014) and never looks like a cache failure. Without a signal the operation
 * runs untouched with zero extra round trips.
 *
 * Pool ownership: an abandoned statement keeps running on its backend, so a
 * pooled checkout that used this helper must NOT be returned to the shared pool
 * while it may still be busy — the next borrower would queue behind the
 * abandoned statement until the backend notices the cancel or its
 * `statement_timeout`. `onAbandoned` reports that case (including a signal that
 * was already aborted when this helper was entered, because the caller has
 * already started the statement), and `withAbortablePostgresClient` uses it to
 * destroy the connection instead of releasing it (`pg-pool`'s `release(true)`).
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { observeBestEffort, settleBestEffort } from '../async/best-effort.js';

export async function withPostgresAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  cancel: () => Promise<unknown>,
  onAbandoned?: () => void,
): Promise<Value> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    // A pre-aborted signal rejects fast, but the statement promise must stay
    // observed so a late rejection can never become an unhandled rejection.
    observeBestEffort(operation,
      'the pre-aborted signal is authoritative over a late query rejection');
    // The operation was already started by the caller, so this checkout may
    // still be busy. Report it before rejecting: an abort that landed between
    // the caller's pre-check and the statement start must not pool the client.
    try {
      onAbandoned?.();
    } catch {
      // Checkout bookkeeping must never replace the authoritative signal reason.
    }
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
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
  // Await only the cancellation attempt: a failed cancel (`false`) does not
  // make the aborted statement worth holding the caller for.
  await settleBestEffort(cancel(),
    'the aborted request result is authoritative over cancellation transport failure');
  // The statement may still be running: tell the owner of the checkout, which
  // destroys the connection instead of returning it to the shared pool.
  try {
    onAbandoned?.();
  } catch {
    // Checkout bookkeeping must never replace the authoritative signal reason.
  }
  // Background-settle: the statement may still be running until the backend
  // observes the cancel (or hits `statement_timeout`). The caller already has
  // the authoritative reason, so this rejection stays observed instead of awaited.
  observeBestEffort(operation,
    'the AbortSignal reason is authoritative over the cancelled query rejection');
  throw reason;
}

/**
 * Reads the exact backend PID of a checked-out client (FIX-L-015), the
 * cancellation target for the runtime's controlled `pg_cancel_backend`.
 * Without a signal no round trip is issued and `undefined` is returned (the
 * no-signal path stays byte-identical to a plain statement run).
 *
 * `onAbandoned` forwards the pool-ownership signal of `withPostgresAbort`: the
 * PID probe is cheap, but a pre-empted probe still leaves its statement on the
 * connection and the checkout owner must not pool it as idle.
 */
export async function readBackendPid(
  client: PoolClient,
  signal: AbortSignal | undefined,
  onAbandoned?: () => void,
): Promise<number | undefined> {
  if (signal === undefined) return undefined;
  // Never start the probe on an already-aborted checkout: the statement would
  // be abandoned immediately and the PID is useless to the caller anyway.
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const backend = await withPostgresAbort(
    client.query<{ pid: number }>('select pg_backend_pid() as pid'),
    signal,
    () => Promise.resolve(),
    onAbandoned,
  );
  const pid = backend.rows[0]?.pid;
  return pid === undefined || !Number.isSafeInteger(pid) || pid < 1 ? undefined : pid;
}

/** A pooled checkout whose statements are abort-aware. */
export interface AbortablePostgresCheckout {
  readonly client: PoolClient;
  /** Exact backend PID observed before the first statement, when available. */
  readonly backendPid: number | undefined;
  /** Runs one statement on this checkout, racing the signal (FIX-L-015). */
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

/**
 * Runs `work` on a checked-out client and destroys the connection when an
 * aborted statement is abandoned instead of releasing a still-busy client to
 * the shared pool. Without a signal the checkout behaves like a plain
 * `pool.connect()` / `client.query()` pair.
 *
 * The cancel is still attempted first — `pg_cancel_backend` stops the
 * server-side statement sooner — but the outcome of the cancel never decides
 * what happens to the checkout: a checkout whose request was aborted is
 * destroyed, never pooled. That includes an abort that lands while this helper
 * waits for `pool.connect()`: the client is destroyed before any statement is
 * issued, so no busy connection and no half-owned checkout reaches the next
 * borrower. `pg-pool`'s `release(true)` removes the client and destroys its
 * socket, so the next checkout opens a fresh connection instead of queueing
 * behind the abandoned statement.
 */
export async function withAbortablePostgresClient<Value>(
  pool: Pick<Pool, 'connect'>,
  signal: AbortSignal | undefined,
  cancelBackend: ((backendPid: number) => Promise<boolean>) | undefined,
  work: (checkout: AbortablePostgresCheckout) => Promise<Value>,
): Promise<Value> {
  // Never check out a connection for a request whose signal already fired.
  // The indirection also defeats TypeScript's narrowing of `signal.aborted`
  // across the await below, where the abort may land while connect() is pending.
  const signalAborted = (): boolean => signal?.aborted === true;
  const abortReason = (): unknown => signal?.reason ?? new DOMException('Aborted', 'AbortError');
  if (signalAborted()) throw abortReason();
  const client = await pool.connect();
  // The abort may have landed while this request waited for the pool. No
  // statement has been issued on the fresh checkout, but destroy it instead of
  // pooling it: an aborted request's connection must never re-enter the pool,
  // and a checkout is cheap compared with handing the next borrower a client
  // whose state depends on how far the abort raced the checkout.
  if (signalAborted()) {
    client.release(true);
    throw abortReason();
  }
  let abandoned = false;
  const markAbandoned = (): void => { abandoned = true; };
  try {
    const backendPid = signal === undefined
      ? undefined
      : await readBackendPid(client, signal, markAbandoned);
    const cancel = async (): Promise<unknown> => {
      if (backendPid === undefined || cancelBackend === undefined) return false;
      return cancelBackend(backendPid);
    };
    const checkout: AbortablePostgresCheckout = Object.freeze({
      client,
      backendPid,
      query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        if (signal === undefined) {
          return values === undefined ? client.query<Row>(text) : client.query<Row>(text, [...values]);
        }
        // Re-check the signal so a statement is never issued on an abort that
        // landed between statements: it would otherwise be unobserved work on a
        // connection that is about to be released.
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        return withPostgresAbort(
          values === undefined ? client.query<Row>(text) : client.query<Row>(text, [...values]),
          signal,
          cancel,
          markAbandoned,
        );
      },
    });
    return await work(checkout);
  } finally {
    // `true` destroys the connection; the alternative hands a busy backend to
    // the next borrower, whose statements would queue behind the abandoned
    // statement until the backend observes the cancel.
    client.release(abandoned);
  }
}
