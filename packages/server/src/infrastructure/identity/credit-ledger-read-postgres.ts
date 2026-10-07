import type { CreditLedgerEntryTable } from '../database/credit-tables.js';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type CreditLedgerBalanceFacts,
  type CreditLedgerEntryBalanceFacts,
  type CreditLedgerEntryFacts,
  type CreditLedgerFilters,
  type CreditLedgerReadPageFacts,
  type CreditLedgerReadPort,
  type CreditLedgerSnapshotFacts,
  type CreditLedgerTaskFacts,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { CreditError } from '../../modules/identity/index.js';
import { createCreditUnitOfWork, createPostgresAccountCreditsPort } from './credits-postgres.js';

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function balanceFacts(row: {
  readonly available: number;
  readonly reserved: number;
  readonly nextExpiryAt: string | null;
  readonly expiringPoints: number;
}): CreditLedgerBalanceFacts {
  return { available: row.available, reserved: row.reserved,
    nextExpiryAt: row.nextExpiryAt, expiringPoints: row.expiringPoints };
}

function mapEntry(row: Selectable<CreditLedgerEntryTable>): CreditLedgerEntryFacts {
  const task = row.task_json as Record<string, unknown> | null;
  const taskFacts: CreditLedgerTaskFacts | null = task === null ? null : {
    kind: task.kind as CreditLedgerTaskFacts['kind'],
    collectionId: String(task.collectionId), nodeId: task.nodeId as string | null,
    runId: task.runId as string | null, actionId: task.actionId as string | null,
  };
  return {
    entryId: String(row.id), sequence: String(row.sequence), kind: row.kind as CreditLedgerEntryFacts['kind'],
    postedAt: instant(row.posted_at as Date | string), effectiveAt: instant(row.effective_at as Date | string),
    pointsDelta: Number(row.points_delta), availableDelta: Number(row.available_delta),
    reservedDelta: Number(row.reserved_delta), expiredPoints: Number(row.expired_points),
    balanceAfter: { available: Number(row.available_after), reserved: Number(row.reserved_after) } satisfies CreditLedgerEntryBalanceFacts,
    operationType: row.operation_type, source: row.source as CreditLedgerEntryFacts['source'],
    reasonCode: row.reason_code, grantId: row.grant_id as string | null,
    chargeId: row.charge_id as string | null, relatedEntryId: row.related_entry_id as string | null,
    expiresAt: row.expires_at === null ? null : instant(row.expires_at as Date | string), task: taskFacts,
  };
}

function applyFilters<T extends Kysely<DatabaseSchema> | DatabaseTransaction>(query: T, accountId: string, filters: CreditLedgerFilters) {
  let result = query.selectFrom('credit_ledger_entries').selectAll().where('account_id', '=', accountId);
  if (filters.kind) result = result.where('kind', '=', filters.kind);
  if (filters.from) result = result.where('posted_at', '>=', sql<Date>`${filters.from}::timestamptz`);
  if (filters.to) result = result.where('posted_at', '<', sql<Date>`${filters.to}::timestamptz`);
  if (filters.chargeId) result = result.where('charge_id', '=', filters.chargeId);
  if (filters.runId) result = result.where(sql<string>`task_json ->> 'runId'`, '=', filters.runId);
  return result;
}

async function readRows(
  transaction: DatabaseTransaction,
  accountId: string,
  filters: CreditLedgerFilters,
  limit: number,
  highSequence?: string,
  beforeSequence?: string,
): Promise<readonly CreditLedgerEntryFacts[]> {
  let query = applyFilters(transaction, accountId, filters);
  if (highSequence !== undefined) query = query.where('sequence', '<=', BigInt(highSequence));
  if (beforeSequence !== undefined) query = query.where('sequence', '<', BigInt(beforeSequence));
  const rows = await query.orderBy('sequence', 'desc').limit(limit + 1).execute();
  return rows.map((row) => mapEntry(row));
}

export function createPostgresCreditLedgerReadPort(db: Kysely<DatabaseSchema>): CreditLedgerReadPort {
  return {
    async readLatest(accountId, filters, limit) {
      return createCreditUnitOfWork(db).execute(async (transaction) => {
        const credits = createPostgresAccountCreditsPort(transaction, accountId);
        await credits.lock();
        const clock = await sql<{ as_of: string }>`SELECT clock_timestamp()::text AS as_of`.execute(transaction);
        const asOf = clock.rows[0]!.as_of;
        const reconciliation = await credits.reconcile(asOf);
        if (reconciliation.hasMore) return { kind: 'reconciling' as const };
        const balance = await credits.balance(asOf);
        const rows = await readRows(transaction, accountId, filters, limit, balance.lastSequence);
        const snapshot: CreditLedgerSnapshotFacts = {
          asOf: instant(asOf), ledgerSequence: balance.lastSequence,
          balance: balanceFacts(balance),
        };
        return { kind: 'ready' as const, page: {
          accountId, snapshot, items: rows.slice(0, limit), hasMore: rows.length > limit,
        } satisfies CreditLedgerReadPageFacts };
      });
    },

    async readPage(accountId, input) {
      return createCreditUnitOfWork(db).execute(async (transaction) => {
        await lockActiveAccount(transaction, accountId);
        const rows = await readRows(transaction, accountId, input.filters, input.limit,
          input.highSequence, input.beforeSequence);
        return {
          accountId, snapshot: input.snapshot, items: rows.slice(0, input.limit), hasMore: rows.length > input.limit,
        } satisfies CreditLedgerReadPageFacts;
      });
    },

    async readEntry(accountId, entryId) {
      return createCreditUnitOfWork(db).execute(async (transaction) => {
        await lockActiveAccount(transaction, accountId);
        const row = await transaction.selectFrom('credit_ledger_entries').selectAll()
          .where('account_id', '=', accountId).where('id', '=', entryId).executeTakeFirst();
        return row ? mapEntry(row) : null;
      });
    },
  };
}

async function lockActiveAccount(transaction: DatabaseTransaction, accountId: string): Promise<void> {
  const account = await transaction.selectFrom('accounts').select('id')
    .where('id', '=', accountId).where('status', '=', 'active').where('deleted_at', 'is', null)
    .forShare().executeTakeFirst();
  if (!account) throw new CreditError('credits_unavailable');
}
