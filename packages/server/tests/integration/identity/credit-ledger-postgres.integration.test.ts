import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations, type DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import {
  createCreditUnitOfWork,
  createPostgresCreditLedgerReadPort,
  createPostgresAccountCreditsPort,
} from '../../../src/infrastructure/identity/index.js';
import { CreditError } from '../../../src/modules/identity/index.js';
import {
  CREDIT_PRICE_VERSION,
  createCreditTestDatabase,
  countRows,
  grantCredits,
  inCreditTransaction,
  refundCredit,
  reserveAndSettle,
  seedCreditAccount,
} from '../../support/credit-ledger-fixture.js';
import {
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('CR-01 account credit ledger over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_ledger');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  const future = (milliseconds = 86_400_000) => new Date(Date.now() + milliseconds);
  const grant = (accountId: string, grantKey = randomUUID(), amount = 10, expiresAt: Date | null = null) =>
    grantCredits(isolated.runtime.db, { accountId, grantKey, amount, expiresAt });

  function reservationInput(chargeId: string, amount = 1) {
    return {
      chargeId,
      operationKey: `credit-ledger-operation-${chargeId}`,
      fingerprint: `credit-ledger-fingerprint-${chargeId}`,
      amount,
      source: 'web' as const,
      priceVersion: CREDIT_PRICE_VERSION,
      ownerKind: 'classification_preview' as const,
      ownerId: chargeId,
      task: {
        kind: 'classification_preview' as const,
        collectionId: 'credit-ledger-collection',
        nodeId: null,
        runId: null,
        actionId: null,
      },
      deadlineAt: future(60_000).toISOString(),
    };
  }

  function errorCode(error: unknown): string | undefined {
    if (error instanceof CreditError) return error.code;
    if (typeof error !== 'object' || error === null) return undefined;
    const candidate = error as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    return errorCode(candidate.cause);
  }

  function expectSqlError(promise: Promise<unknown>, message: string) {
    return expect(promise).rejects.toMatchObject({ code: 'P0001', message });
  }

  test('G1 is idempotent under same-key concurrency and rejects a changed fingerprint', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'grant-idempotency');
    const input = { accountId: account.accountId, grantKey: 'period-2026-09-19', amount: 100, expiresAt: future() };

    const results = await Promise.all([grantCredits(isolated.runtime.db, input), grantCredits(isolated.runtime.db, input)]);
    expect(results).toHaveLength(2);
    expect(await countRows(isolated.runtime.db, 'credit_grants', account.accountId)).toBe(1);
    expect(await countRows(isolated.runtime.db, 'credit_ledger_entries', account.accountId)).toBe(1);

    await expectSqlError(grantCredits(isolated.runtime.db, { ...input, amount: 101 }), 'credit_key_reused');
    expect(await countRows(isolated.runtime.db, 'credit_grants', account.accountId)).toBe(1);
    expect(await countRows(isolated.runtime.db, 'credit_ledger_entries', account.accountId)).toBe(1);
  });

  test('reservation, settlement and Q1 balance remain one-account atomic', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'reserve-settle');
    await grant(account.accountId, 'reserve-settle-grant', 3);
    const chargeId = randomUUID();

    const reserved = await inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
      const first = await credits.reserve(reservationInput(chargeId));
      const replay = await credits.reserve(reservationInput(chargeId));
      expect(replay).toBe(first);
      return first;
    });
    expect(reserved).toBe(chargeId);

    const held = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits, transaction) =>
      credits.balance(new Date()).then(async (balance) => ({ balance,
        charge: await sql<{ state: string; quoted_amount: string }>`
          SELECT state, quoted_amount::text FROM credit_charges WHERE account_id = ${account.accountId} AND id = ${chargeId}::uuid
        `.execute(transaction),
      })));
    expect(held.balance).toMatchObject({ available: 2, reserved: 1 });
    expect(held.charge.rows[0]).toMatchObject({ state: 'reserved', quoted_amount: '1' });

    await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.settle(chargeId));
    const settled = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
    expect(settled).toMatchObject({ available: 2, reserved: 0 });
    expect(await countRows(isolated.runtime.db, 'credit_ledger_entries', account.accountId)).toBe(3);
  });

  test('two last-point reservations have exactly one winner', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'last-point');
    await grant(account.accountId, 'last-point-grant', 1);
    const attempts = [0, 1].map(async () => inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
      const chargeId = randomUUID();
      await credits.reserve(reservationInput(chargeId));
      return chargeId;
    }));
    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => errorCode(outcome.reason)))
      .toEqual([expect.stringMatching(/insufficient|busy|balance/i)]);
    const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
    expect(balance).toMatchObject({ available: 0, reserved: 1 });
    expect(await countRows(isolated.runtime.db, 'credit_charges', account.accountId)).toBe(1);
  });

  test('TX-04 a reserve waiting for L1 cannot use an expired batch, and release cannot revive it', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'expiry-l1-barrier');
    const expiresAt = future(500);
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'expiring', amount: 1, expiresAt });
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'expiring-second', amount: 1, expiresAt });
    const oldChargeId = await inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
      const id = randomUUID();
      await credits.reserve(reservationInput(id));
      return id;
    });
    const blocker = await isolated.runtime.pool.connect();
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT credit_lock_account($1,true)', [account.accountId]);
      const newChargeId = randomUUID();
      const waitingReserve = inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
        await credits.reserve(reservationInput(newChargeId));
        return newChargeId;
      }).then((value) => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      await expect.poll(async () => {
        const result = await isolated.runtime.pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
             WHERE datname=current_database() AND pid<>pg_backend_pid()
               AND wait_event_type='Lock' AND query LIKE '%credit_lock_account%') AS waiting`);
        return result.rows[0]?.waiting;
      }, { timeout: 5_000, interval: 5 }).toBe(true);
      await expect.poll(async () => {
        const result = await isolated.runtime.pool.query<{ expired: boolean }>(
          'SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiresAt]);
        return result.rows[0]?.expired;
      }, { timeout: 5_000, interval: 5 }).toBe(true);
      await blocker.query('COMMIT');committed = true;
      const reserveOutcome = await waitingReserve;
      expect(reserveOutcome.kind).toBe('rejected');
      if (reserveOutcome.kind === 'rejected') {
        expect(reserveOutcome.error).toMatchObject({ message: expect.stringMatching(/insufficient|expired|busy/i) });
      }
      await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.release(oldChargeId, 'classification_failed'));
      const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
      expect(balance).toMatchObject({ available: 0, reserved: 0 });
      const charges = await isolated.runtime.db.selectFrom('credit_charges').select(['id', 'state'])
        .where('account_id', '=', account.accountId).orderBy('created_at').execute();
      expect(charges).toEqual([{ id: oldChargeId, state: 'released' }]);
      const entries = await isolated.runtime.db.selectFrom('credit_ledger_entries').select(['kind', 'expired_points'])
        .where('account_id', '=', account.accountId).orderBy('sequence').execute();
      expect(entries.map((entry) => entry.kind)).toEqual(['grant', 'grant', 'reserve', 'expire', 'release']);
      expect(entries.at(-1)).toMatchObject({ kind: 'release', expired_points: '1' });
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  test('R1 is idempotent by refund key and concurrent different keys cannot exceed settled spend', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'refund-cap');
    await grant(account.accountId, 'refund-source', 2);
    const chargeId = await reserveAndSettle(isolated.runtime.db, account.accountId);
    const input = { accountId: account.accountId, refundKey: 'refund-once', chargeId, amount: 1, expiresAt: future() };
    const sameKey = await Promise.all([refundCredit(isolated.runtime.db, input), refundCredit(isolated.runtime.db, input)]);
    expect(sameKey).toHaveLength(2);
    expect(await countRows(isolated.runtime.db, 'credit_grants', account.accountId)).toBe(2);
    expect(await countRows(isolated.runtime.db, 'credit_ledger_entries', account.accountId)).toBe(4);

    const extra = await Promise.allSettled([
      refundCredit(isolated.runtime.db, { ...input, refundKey: 'refund-over', amount: 1 }),
      refundCredit(isolated.runtime.db, { ...input, refundKey: 'refund-over-2', amount: 1 }),
    ]);
    expect(extra.every((outcome) => outcome.status === 'rejected')).toBe(true);
    for (const outcome of extra) {
      if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({
        code: 'P0001', message: 'credit_refund_exceeds_charge',
      });
    }
    expect(await countRows(isolated.runtime.db, 'credit_grants', account.accountId)).toBe(2);
    const charge = await isolated.runtime.db.selectFrom('credit_charges').select(['settled_amount', 'refunded_amount'])
      .where('account_id', '=', account.accountId).where('id', '=', chargeId).executeTakeFirstOrThrow();
    expect(String(charge.refunded_amount)).toBe('1');
    expect(String(charge.settled_amount)).toBe('1');
  });

  test('amount bounds and account status fail closed before any ledger mutation', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'limits');
    await expectSqlError(grant(account.accountId, 'invalid-zero', 0), 'credit_invalid_amount');
    await expectSqlError(grant(account.accountId, 'invalid-negative', -1), 'credit_invalid_amount');
    await expectSqlError(grant(account.accountId, 'invalid-overflow', 2_147_483_648), 'credit_invalid_amount');
    expect(await countRows(isolated.runtime.db, 'credit_grants', account.accountId)).toBe(0);

    const disabled = await seedCreditAccount(isolated.runtime.db, 'disabled', { status: 'disabled' });
    await expect(inCreditTransaction(isolated.runtime.db, disabled.accountId, (credits) => credits.balance(new Date())))
      .rejects.toMatchObject({ code: 'credits_unavailable' });
    expect(await countRows(isolated.runtime.db, 'credit_accounts', disabled.accountId)).toBe(0);
  });

  test('composite account foreign keys prevent cross-account allocations', async () => {
    const first = await seedCreditAccount(isolated.runtime.db, 'fk-a');
    const second = await seedCreditAccount(isolated.runtime.db, 'fk-b');
    await grant(first.accountId, 'fk-grant-a', 1);
    await grant(second.accountId, 'fk-grant-b', 1);
    const chargeId = await inCreditTransaction(isolated.runtime.db, first.accountId, async (credits) => {
      const id = randomUUID();
      await credits.reserve(reservationInput(id));
      return id;
    });
    const grantId = await isolated.runtime.db.selectFrom('credit_grants').select('id')
      .where('account_id', '=', second.accountId).executeTakeFirstOrThrow();
    for (const accountId of [first.accountId, second.accountId]) {
      await expect(isolated.runtime.db.transaction().execute(async transaction => {
        // Each referenced ID exists, but no account owns both sides of this pair.
        await sql`SELECT set_config('known.credits_internal_xact', txid_current()::text, true)`.execute(transaction);
        await sql`INSERT INTO credit_allocations(account_id, charge_id, grant_id, amount)
          VALUES (${accountId}, ${chargeId}::uuid, ${grantId.id}::uuid, 1)`.execute(transaction);
      })).rejects.toMatchObject({ code: '23503' });
    }
    expect(await countRows(isolated.runtime.db, 'credit_allocations', second.accountId)).toBe(0);
  });

  test('grant/charge/ledger invariants hold after mixed reserve, release, spend and refund events', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'invariants');
    await grant(account.accountId, 'invariant-grant', 5);
    const released = await inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
      const id = randomUUID();
      await credits.reserve(reservationInput(id));
      await credits.release(id, 'classification_failed');
      return id;
    });
    const settled = await reserveAndSettle(isolated.runtime.db, account.accountId);
    await refundCredit(isolated.runtime.db, {
      accountId: account.accountId, refundKey: 'invariant-refund', chargeId: settled, amount: 1, expiresAt: future(),
    });
    expect(released).toBeTruthy();
    const grants = await isolated.runtime.db.selectFrom('credit_grants').selectAll()
      .where('account_id', '=', account.accountId).execute();
    for (const row of grants) {
      const amount = BigInt(row.amount);
      expect(BigInt(row.reserved_amount) + BigInt(row.spent_amount) + BigInt(row.expired_amount)).toBeLessThanOrEqual(amount);
      expect(amount).toBeGreaterThan(0n);
    }
    const entries = await isolated.runtime.db.selectFrom('credit_ledger_entries').selectAll()
      .where('account_id', '=', account.accountId).orderBy('sequence').execute();
    let available = 0n;
    let reserved = 0n;
    for (const row of entries) {
      const availableDelta = BigInt(row.available_delta);
      const reservedDelta = BigInt(row.reserved_delta);
      expect(BigInt(row.points_delta)).toBe(availableDelta + reservedDelta);
      available += availableDelta;
      reserved += reservedDelta;
      expect(BigInt(row.available_after)).toBe(available);
      expect(BigInt(row.reserved_after)).toBe(reserved);
      expect(available).toBeGreaterThanOrEqual(0n);
      expect(reserved).toBeGreaterThanOrEqual(0n);
    }
    const charges = await isolated.runtime.db.selectFrom('credit_charges').selectAll()
      .where('account_id', '=', account.accountId).execute();
    for (const row of charges) {
      if (row.state === 'reserved') {
        expect(String(row.settled_amount)).toBe('0');
        expect(String(row.refunded_amount)).toBe('0');
      } else if (row.state === 'settled') {
        expect(String(row.settled_amount)).toBe(String(row.quoted_amount));
        expect(BigInt(row.refunded_amount)).toBeLessThanOrEqual(BigInt(row.settled_amount));
      } else {
        expect(String(row.settled_amount)).toBe('0');
        expect(String(row.refunded_amount)).toBe('0');
      }
    }
    expect(entries.length).toBe(6);
  });

  test('TX-13 mixed valid/expired release records expiredPoints, then refund creates a new grant', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'mixed-release-refund');
    const expiresAt = future(500);
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'mixed-expiring', amount: 1, expiresAt });
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'mixed-valid', amount: 1, expiresAt: future() });
    const held = await inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => {
      const id = randomUUID();
      await credits.reserve({ ...reservationInput(id, 2), operationKey: `mixed-release-${id}` });
      return id;
    });
    await expect.poll(async () => {
      const result = await isolated.runtime.pool.query<{ expired: boolean }>(
        'SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiresAt]);
      return result.rows[0]?.expired;
    }, { timeout: 5_000, interval: 5 }).toBe(true);
    await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.release(held, 'classification_failed'));
    const afterRelease = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
    expect(afterRelease).toMatchObject({ available: 1, reserved: 0 });
    const releaseEntry = await isolated.runtime.db.selectFrom('credit_ledger_entries').select(['kind', 'available_delta', 'reserved_delta', 'expired_points'])
      .where('account_id', '=', account.accountId).where('charge_id', '=', held).where('kind', '=', 'release').executeTakeFirstOrThrow();
    expect(releaseEntry.kind).toBe('release');
    expect(String(releaseEntry.available_delta)).toBe('1');
    expect(String(releaseEntry.reserved_delta)).toBe('-2');
    expect(String(releaseEntry.expired_points)).toBe('1');

    const spent = await reserveAndSettle(isolated.runtime.db, account.accountId);
    await refundCredit(isolated.runtime.db, {
      accountId: account.accountId, refundKey: 'mixed-refund', chargeId: spent, amount: 1, expiresAt: future(),
    });
    const finalBalance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
    expect(finalBalance).toMatchObject({ available: 1, reserved: 0 });
    const originalCharge = await isolated.runtime.db.selectFrom('credit_charges').select(['state', 'settled_amount', 'refunded_amount'])
      .where('account_id', '=', account.accountId).where('id', '=', spent).executeTakeFirstOrThrow();
    expect(originalCharge.state).toBe('settled');
    expect(String(originalCharge.settled_amount)).toBe('1');
    expect(String(originalCharge.refunded_amount)).toBe('1');
    const refundEntry = await isolated.runtime.db.selectFrom('credit_ledger_entries').select(['kind', 'grant_id', 'charge_id', 'related_entry_id'])
      .where('account_id', '=', account.accountId).where('event_key', '=', 'refund:mixed-refund').executeTakeFirstOrThrow();
    expect(refundEntry).toMatchObject({ kind: 'refund', charge_id: spent });
    expect(refundEntry.grant_id).not.toBeNull();
    expect(refundEntry.related_entry_id).not.toBeNull();
  });

  test('reconcile processes at most 100 expired grants per transaction and converges', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'reconcile');
    const expiresAt = future(5_000);
    for (let index = 0; index < 101; index += 1) {
      await grantCredits(isolated.runtime.db, {
        accountId: account.accountId,
        grantKey: `expired-${index}`,
        amount: 1,
        expiresAt,
      });
    }
    await expect.poll(async () => {
      const result = await isolated.runtime.pool.query<{ expired: boolean }>(
        'SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiresAt]);
      return result.rows[0]?.expired;
    }, { timeout: 10_000, interval: 5 }).toBe(true);

    const first = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.reconcile());
    expect(first).toMatchObject({ processed: 100, hasMore: true });
    const second = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.reconcile());
    expect(second).toMatchObject({ processed: 1, hasMore: false });
    const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) => credits.balance(new Date()));
    expect(balance.available).toBe(0);
    expect(await isolated.runtime.db.selectFrom('credit_grants').select('id').where('account_id', '=', account.accountId)
      .where('expiry_processed_at', 'is', null).execute()).toHaveLength(0);
  }, 30_000);

  test('TX-10 readLatest rolls back an expiry fault and retries through the real ledger read port', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'reconcile-fault');
    const expiresAt = future(500);
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'fault-a', amount: 1, expiresAt });
    await grantCredits(isolated.runtime.db, { accountId: account.accountId, grantKey: 'fault-b', amount: 1, expiresAt });
    const suffix = randomUUID().replaceAll('-', '_');
    const functionName = `credit_test_expiry_fault_${suffix}`;
    const triggerName = `credit_test_expiry_trigger_${suffix}`;
    const escapedAccount = account.accountId.replaceAll("'", "''");
    await sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.account_id='${escapedAccount}' AND NEW.expiry_processed_at IS NOT NULL THEN
          RAISE EXCEPTION 'injected_expiry_fault' USING ERRCODE='P0001';
        END IF;
        RETURN NEW;
      END $function$`).execute(isolated.runtime.db);
    await sql.raw(`CREATE TRIGGER ${triggerName} AFTER UPDATE OF expiry_processed_at ON credit_grants
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`).execute(isolated.runtime.db);
    const reader = createPostgresCreditLedgerReadPort(isolated.runtime.db);
    try {
      await expect.poll(async () => {
        const result = await isolated.runtime.pool.query<{ expired: boolean }>(
          'SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiresAt]);
        return result.rows[0]?.expired;
      }, { timeout: 5_000, interval: 5 }).toBe(true);
      await expect(reader.readLatest(account.accountId, {}, 20)).rejects.toBeDefined();
      expect(await isolated.runtime.db.selectFrom('credit_grants').select('id').where('account_id', '=', account.accountId)
        .where('expiry_processed_at', 'is', null).execute()).toHaveLength(2);
      expect((await isolated.runtime.db.selectFrom('credit_ledger_entries').select('kind').where('account_id', '=', account.accountId)
        .execute()).map((entry) => entry.kind)).toEqual(['grant', 'grant']);
    } finally {
      await sql.raw(`DROP TRIGGER ${triggerName} ON credit_grants`).execute(isolated.runtime.db);
      await sql.raw(`DROP FUNCTION ${functionName}()`).execute(isolated.runtime.db);
    }
    const ready = await reader.readLatest(account.accountId, {}, 20);
    expect(ready.kind).toBe('ready');
    expect(await isolated.runtime.db.selectFrom('credit_grants').select('id').where('account_id', '=', account.accountId)
      .where('expiry_processed_at', 'is', null).execute()).toHaveLength(0);
    expect((await isolated.runtime.db.selectFrom('credit_ledger_entries').select('kind').where('account_id', '=', account.accountId)
      .orderBy('sequence').execute()).map((entry) => entry.kind)).toEqual(['grant', 'grant', 'expire', 'expire']);
  });

  test('lost COMMIT acknowledgement is credits_unavailable, and replay observes the one committed reserve', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, 'commit-ack');
    await grant(account.accountId, 'commit-ack-grant', 1);
    const chargeId = randomUUID();
    const unit = createCreditUnitOfWork(isolated.runtime.db, {
      faultInjector: { afterCommitAcknowledged: () => { throw new Error('simulated lost acknowledgement'); } },
    });
    await expect(unit.execute(async (transaction) => {
      const credits = createPostgresAccountCreditsPort(transaction, account.accountId);
      await credits.lock();
      return credits.reserve(reservationInput(chargeId));
    })).rejects.toMatchObject({ code: 'credits_unavailable' });

    const observed = await inCreditTransaction(isolated.runtime.db, account.accountId, async (credits) => ({
      balance: await credits.balance(new Date()),
      replay: await credits.reserve(reservationInput(chargeId)),
    }));
    expect(observed.balance).toMatchObject({ available: 0, reserved: 1 });
    expect(observed.replay).toBe(chargeId);
    expect(await countRows(isolated.runtime.db, 'credit_ledger_entries', account.accountId)).toBe(2);
  });
});
