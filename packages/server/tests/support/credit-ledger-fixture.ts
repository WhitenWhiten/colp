import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import type { AccountCreditsPort } from '../../src/modules/identity/index.js';
import {
  createCreditUnitOfWork,
  createPostgresAccountCreditsPort,
} from '../../src/infrastructure/identity/index.js';
import type { DatabaseSchema, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { requireTestDatabaseUrl, type IsolatedPostgresRuntime } from './postgres-test-runtime.js';

/** The frozen known_credits schema is tested in a whole isolated database. */
export async function createCreditTestDatabase(prefix: string, maxConnections = 12): Promise<IsolatedPostgresRuntime> {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Invalid test database prefix');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  if (name.length > 63) throw new Error('Test database name exceeds PostgreSQL identifier limit');
  const administrator = new Pool({ connectionString: requireTestDatabaseUrl(), max: 1 });
  await administrator.query(`CREATE DATABASE "${name}"`);
  const url = new URL(requireTestDatabaseUrl());
  url.pathname = `/${name}`;
  url.searchParams.set('options', '-c search_path=public');
  const runtime = createDatabaseRuntime(url.toString(), { maxConnections,
    applicationName: `known-test-${prefix}`, connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000 });
  return { databaseUrl: url.toString(), schema: 'public', runtime,
    async close() {
      await runtime.close();
      try { await administrator.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await administrator.end(); }
    },
  };
}

export const CREDIT_PRICE_VERSION = 'bookmark-classify.v1';
export const CREDIT_OPERATION_TYPE = 'bookmark.classify';

export interface CreditAccountFixture {
  readonly accountId: string;
  readonly subjectId: string;
}

export interface CreditGrantInput {
  readonly accountId: string;
  readonly grantKey: string;
  readonly amount: number;
  readonly validFrom?: Date;
  readonly expiresAt?: Date | null;
  readonly source?: 'operator' | 'scheduler';
  readonly reasonCode?: 'manual_grant' | 'trial_grant';
  readonly operatorNote?: string;
}

export interface CreditRefundInput {
  readonly accountId: string;
  readonly refundKey: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly expiresAt?: Date | null;
  readonly operatorNote?: string;
}

/** Seeds only the account row required by the account-owned credit tables. */
export async function seedCreditAccount(
  db: Kysely<DatabaseSchema>,
  suffix = randomUUID(),
  options: { readonly status?: 'active' | 'disabled' | 'deleted' } = {},
): Promise<CreditAccountFixture> {
  const accountId = `credit-account-${suffix}`;
  const subjectId = `credit-subject-${suffix}`;
  await db.insertInto('accounts').values({
    id: accountId,
    subject_id: subjectId,
    status: options.status ?? 'active',
    email: null,
    security_epoch: 0n,
    created_at: new Date('2026-09-19T00:00:00.000Z'),
    deleted_at: options.status === 'deleted' ? new Date('2026-09-19T00:00:00.000Z') : null,
  }).execute();
  return { accountId, subjectId };
}

/** Calls the public operator/scheduler grant contract, never the table directly. */
export async function grantCredits(
  db: Kysely<DatabaseSchema>,
  input: CreditGrantInput,
): Promise<unknown> {
  const result = await sql`
    SELECT * FROM known_credits.grant_credits(
      ${input.accountId}, ${input.grantKey}, ${input.amount}::bigint,
      ${input.validFrom ?? new Date('2026-09-19T00:00:00.000Z')}::timestamptz,
      ${input.expiresAt ?? null}::timestamptz, ${input.source ?? 'operator'},
      ${input.reasonCode ?? 'manual_grant'}, ${input.operatorNote ?? 'credit-ledger-test'}
    )
  `.execute(db);
  return result.rows[0];
}

/** Calls the public operator refund contract; payment/HTTP paths are out of scope. */
export async function refundCredit(
  db: Kysely<DatabaseSchema>,
  input: CreditRefundInput,
): Promise<unknown> {
  const result = await sql`
    SELECT * FROM known_credits.refund_credit_charge(
      ${input.accountId}, ${input.refundKey}, ${input.chargeId}::uuid,
      ${input.amount}::bigint, ${input.expiresAt ?? null}::timestamptz,
      ${input.operatorNote ?? 'credit-ledger-test'}
    )
  `.execute(db);
  return result.rows[0];
}

export async function reconcileExpiredCredits(
  db: Kysely<DatabaseSchema>,
  accountId: string,
): Promise<unknown> {
  const result = await sql`
    SELECT * FROM known_credits.reconcile_expired_credits(${accountId})
  `.execute(db);
  return result.rows[0];
}

export async function inCreditTransaction<Result>(
  db: Kysely<DatabaseSchema>,
  accountId: string,
  work: (credits: AccountCreditsPort, transaction: DatabaseTransaction) => Promise<Result>,
  options: Parameters<typeof createCreditUnitOfWork>[1] = {},
): Promise<Result> {
  return createCreditUnitOfWork(db, options).execute(async (transaction) => {
    const credits = createPostgresAccountCreditsPort(transaction, accountId);
    await credits.lock();
    return work(credits, transaction);
  });
}

export async function reserveAndSettle(
  db: Kysely<DatabaseSchema>,
  accountId: string,
  options: {
    readonly chargeId?: string;
    readonly operationKey?: string;
    readonly amount?: number;
    readonly deadlineAt?: Date;
  } = {},
): Promise<string> {
  return inCreditTransaction(db, accountId, async (credits) => {
    const chargeId = options.chargeId ?? randomUUID();
    const amount = options.amount ?? 1;
    const reserved = await credits.reserve({
      chargeId,
      operationKey: options.operationKey ?? `credit-ledger-test-${chargeId}`,
      fingerprint: `credit-ledger-test-fingerprint-${chargeId}`,
      amount,
      source: 'web',
      priceVersion: CREDIT_PRICE_VERSION,
      ownerKind: 'classification_preview',
      ownerId: chargeId,
      task: {
        kind: 'classification_preview',
        collectionId: 'credit-ledger-collection',
        nodeId: null,
        runId: null,
        actionId: null,
      },
      deadlineAt: (options.deadlineAt ?? new Date(Date.now() + 60_000)).toISOString(),
    });
    await credits.settle(reserved);
    return reserved;
  });
}

export async function countRows(
  db: Kysely<DatabaseSchema>,
  table: 'credit_accounts' | 'credit_grants' | 'credit_charges' | 'credit_allocations' | 'credit_ledger_entries',
  accountId: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM ${sql.id(table)} WHERE account_id = ${accountId}
  `.execute(db);
  return Number(result.rows[0]?.count ?? 0);
}
