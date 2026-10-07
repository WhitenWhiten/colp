import { sql, type Kysely } from 'kysely';
import {
  CreditError, type AccountCreditsPort, type CreditBalanceFacts, type CreditReconciliation,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { DatabaseOperationError } from '../database/errors.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { rethrowCreditError } from './credit-errors.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';

interface ReconciliationRow { processed: number; has_more: boolean; last_sequence: string }
interface BalanceRow {
  available: string; reserved: string; next_expiry_at: Date | null;
  expiring_points: string; last_sequence: string;
}

/** Binds financial writes to the business owner's transaction; it never commits on its own. */
export function createPostgresAccountCreditsPort(transaction: DatabaseTransaction, accountId: string): AccountCreditsPort {
  let locked = false;
  const assertLocked = () => { if (!locked) throw new CreditError('credits_unavailable'); };
  return {
    async lock(options = {}) {
      const result = await sql<{ as_of: Date }>`SELECT credit_lock_account(${accountId}, ${options.allowInactive ?? false}) AS as_of`
        .execute(transaction);
      locked = true;
      return result.rows[0]!.as_of;
    },
    async lockFinancialRows() {
      assertLocked();
      await sql`SELECT credit_lock_financial_rows(${accountId})`.execute(transaction);
    },
    async reconcile(asOf): Promise<CreditReconciliation> {
      assertLocked();
      const result = await sql<ReconciliationRow>`SELECT * FROM credit_reconcile_expired(${accountId},
        coalesce(${asOf ?? null}::timestamptz, clock_timestamp()))`.execute(transaction);
      const row = result.rows[0]!;
      return { processed: row.processed, hasMore: row.has_more, lastSequence: String(row.last_sequence) };
    },
    async balance(asOf): Promise<CreditBalanceFacts> {
      assertLocked();
      const result = await sql<BalanceRow>`SELECT * FROM credit_balance(${accountId}, ${asOf})`.execute(transaction);
      const row = result.rows[0]!;
      return { available: Number(row.available), reserved: Number(row.reserved),
        nextExpiryAt: row.next_expiry_at?.toISOString() ?? null, expiringPoints: Number(row.expiring_points),
        lastSequence: String(row.last_sequence) };
    },
    async hasExpiryBacklog(asOf) {
      assertLocked();
      const result = await sql<{ pending: number }>`SELECT count(*)::int AS pending FROM
        (SELECT 1 FROM credit_grants WHERE account_id=${accountId} AND expires_at<=${asOf}::timestamptz
          AND expiry_processed_at IS NULL LIMIT 101) pending`.execute(transaction);
      return result.rows[0]!.pending > 100;
    },
    async isReserved(chargeId) {
      assertLocked();
      const result = await sql<{ reserved: boolean }>`SELECT EXISTS(SELECT 1 FROM credit_charges
        WHERE account_id=${accountId} AND id=${chargeId}::uuid AND state='reserved') AS reserved`.execute(transaction);
      return result.rows[0]!.reserved;
    },
    async totals(chargeIds) {
      const result = await sql<{ quoted: string; reserved: string; settled: string; released: string }>`SELECT
        coalesce(sum(quoted_amount),0)::bigint AS quoted,
        coalesce(sum(quoted_amount) FILTER(WHERE state='reserved'),0)::bigint AS reserved,
        coalesce(sum(settled_amount),0)::bigint AS settled,
        coalesce(sum(quoted_amount) FILTER(WHERE state='released'),0)::bigint AS released
        FROM credit_charges WHERE account_id=${accountId} AND id=ANY(${[...chargeIds]}::uuid[])`.execute(transaction);
      const row = result.rows[0]!;
      return { quoted: Number(row.quoted), reserved: Number(row.reserved), settled: Number(row.settled), released: Number(row.released) };
    },
    async reserve(input) {
      assertLocked();
      const result = await sql<{ charge_id: string }>`SELECT credit_reserve(${accountId}, ${input.chargeId}::uuid,
        ${input.operationKey}, ${input.fingerprint}, ${input.amount}::bigint, ${input.source}, ${input.priceVersion},
        ${input.ownerKind}, ${input.ownerId}, ${JSON.stringify(input.task)}::jsonb, ${input.deadlineAt}::timestamptz) AS charge_id`
        .execute(transaction);
      return result.rows[0]!.charge_id;
    },
    async settle(chargeId) {
      assertLocked();
      const result = await sql<{ changed: boolean }>`SELECT credit_finish(${accountId}, ${chargeId}::uuid, true,
        'classification_completed') AS changed`.execute(transaction);
      return result.rows[0]!.changed;
    },
    async release(chargeId, reason) {
      assertLocked();
      const result = await sql<{ changed: boolean }>`SELECT credit_finish(${accountId}, ${chargeId}::uuid, false, ${reason}) AS changed`
        .execute(transaction);
      return result.rows[0]!.changed;
    },
  };
}

export type PostgresAccountCreditsFactory = typeof createPostgresAccountCreditsPort;

/** Each call gets a fresh 2s deadline, including lock waits and COMMIT acknowledgement. */
export function createCreditUnitOfWork(db: Kysely<DatabaseSchema>, options: Pick<UnitOfWorkOptions, 'faultInjector' | 'signal' | 'cancelBackend'> = {}) {
  return {
    async execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      const deadline = AbortSignal.timeout(2_000);
      const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
      try {
        const work = createUnitOfWork(db, { ...options, signal }).execute(async ({ transaction }) => {
          // Cancellation must not borrow the connection that this transaction
          // retains until cleanup completes, including when the pool is full.
          const disposeCancellation = options.cancelBackend ? undefined
            : await installPostgresTransactionCancellation(transaction, signal);
          try {
            if (signal.aborted) throw signal.reason;
            await sql`SET LOCAL lock_timeout = '250ms'`.execute(transaction);
            await sql`SET LOCAL statement_timeout = '2s'`.execute(transaction);
            await sql`SET LOCAL idle_in_transaction_session_timeout = '2s'`.execute(transaction);
            return await callback(transaction);
          } finally {
            await disposeCancellation?.();
          }
        });
        return await new Promise<Result>((resolve, reject) => {
          const abort = () => reject(new CreditError('credits_unavailable', undefined, { cause: signal.reason }));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          // The underlying unit drains/rolls back even when pool acquisition or
          // COMMIT acknowledgement outlasts the HTTP deadline. Never assume rollback.
          void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
      } catch (error) {
        if (error instanceof DatabaseOperationError || error instanceof CreditError || signal.aborted) return rethrowCreditError(error);
        throw error;
      }
    },
  };
}

/** Independent, bounded maintenance must commit before a business receipt is claimed. */
export async function reconcileAccountCredits(db: Kysely<DatabaseSchema>, accountId: string,
  options: Pick<UnitOfWorkOptions, 'signal' | 'cancelBackend'> & { readonly allowInactive?: boolean } = {}): Promise<void> {
  const result = await createCreditUnitOfWork(db, options).execute(async transaction => {
    const credits = createPostgresAccountCreditsPort(transaction, accountId);
    await credits.lock({ allowInactive: options.allowInactive });
    return credits.reconcile();
  });
  if (result.hasMore) throw new CreditError('credits_reconciling');
}
