import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createCreditTestDatabase,
  grantCredits,
  inCreditTransaction,
  reconcileExpiredCredits,
  refundCredit,
  seedCreditAccount,
} from '../../support/credit-ledger-fixture.js';
import {
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const EXPIRED_U = '2026-09-18 00:00:00+00';
const HISTORICAL = '2026-09-17 00:00:00+00';

describeWithPostgres('CR-01 credit expiry and historical settlement PostgreSQL contracts', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_expiry', 12);
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('TX-13 release splits valid and expired allocation without reviving yesterday points', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, randomUUID());
    const chargeId = randomUUID();
    const validGrantId = randomUUID();
    const expiredGrantId = randomUUID();
    await prepareMixedReservedCharge(account.accountId, chargeId, validGrantId, expiredGrantId);

    const changed = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) =>
      credits.release(chargeId, 'classification_failed'));
    expect(changed).toBe(true);

    const release = await isolated.runtime.pool.query<{
      available_delta: string; reserved_delta: string; points_delta: string; expired_points: string;
    }>(`select available_delta, reserved_delta, points_delta, expired_points
          from credit_ledger_entries
         where account_id = $1 and event_key = $2`, [account.accountId, `release:${chargeId}`]);
    expect(release.rows[0]).toEqual({
      available_delta: '0', reserved_delta: '-1', points_delta: '-1', expired_points: '1',
    });

    const grants = await isolated.runtime.pool.query<{
      id: string; amount: string; reserved_amount: string; spent_amount: string; expired_amount: string;
    }>(`select id, amount, reserved_amount, spent_amount, expired_amount
          from credit_grants where account_id = $1 order by id`, [account.accountId]);
    const valid = grants.rows.find((row) => row.id === validGrantId);
    const expired = grants.rows.find((row) => row.id === expiredGrantId);
    expect(valid).toMatchObject({ amount: '2', reserved_amount: '0', spent_amount: '0', expired_amount: '0' });
    expect(expired).toMatchObject({ amount: '1', reserved_amount: '0', spent_amount: '0', expired_amount: '1' });
    const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) =>
      credits.balance(new Date()));
    expect(balance).toMatchObject({ available: 2, reserved: 0 });
    await assertLedgerAndGrantFormula(account.accountId);
  });

  test('TX-13 settled spend can be refunded after its source grant expires into one new grant', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, randomUUID());
    const chargeId = randomUUID();
    const sourceGrantId = randomUUID();
    await prepareExpiredSettledCharge(account.accountId, chargeId, sourceGrantId);

    const spendBefore = await isolated.runtime.pool.query<{
      points_delta: string; grant_id: string | null; related_entry_id: string | null;
    }>(`select points_delta, grant_id, related_entry_id
          from credit_ledger_entries
         where account_id = $1 and event_key = $2`, [account.accountId, `spend:${chargeId}`]);
    const refundKey = `expired-refund-${randomUUID()}`;
    const refundExpiresAt = new Date(Date.now() + 86_400_000);
    const first = await refundCredit(isolated.runtime.db, {
      accountId: account.accountId, refundKey, chargeId, amount: 1, expiresAt: refundExpiresAt,
    });
    const replay = await refundCredit(isolated.runtime.db, {
      accountId: account.accountId, refundKey, chargeId, amount: 1, expiresAt: refundExpiresAt,
    });
    expect(first).toMatchObject({ replayed: false });
    expect(replay).toMatchObject({ replayed: true });
    expect(await countRows('credit_grants', account.accountId)).toBe(2);
    expect(await countRows('credit_ledger_entries', account.accountId)).toBe(4);

    const spendAfter = await isolated.runtime.pool.query<{
      points_delta: string; grant_id: string | null; related_entry_id: string | null;
    }>(`select points_delta, grant_id, related_entry_id
          from credit_ledger_entries
         where account_id = $1 and event_key = $2`, [account.accountId, `spend:${chargeId}`]);
    expect(spendAfter.rows).toEqual(spendBefore.rows);
    const charge = await isolated.runtime.pool.query<{ state: string; settled_amount: string; refunded_amount: string }>(
      `select state, settled_amount, refunded_amount from credit_charges where id = $1::uuid`, [chargeId]);
    expect(charge.rows[0]).toEqual({ state: 'settled', settled_amount: '1', refunded_amount: '1' });
    const source = await isolated.runtime.pool.query<{
      reserved_amount: string; spent_amount: string; expired_amount: string; expiry_processed_at: Date | null;
    }>(`select reserved_amount, spent_amount, expired_amount, expiry_processed_at
          from credit_grants where id = $1::uuid`, [sourceGrantId]);
    expect(source.rows[0]).toMatchObject({ reserved_amount: '0', spent_amount: '1', expired_amount: '0' });
    expect(source.rows[0]?.expiry_processed_at).not.toBeNull();
    const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) =>
      credits.balance(new Date()));
    expect(balance).toMatchObject({ available: 1, reserved: 0 });
    await assertLedgerAndGrantFormula(account.accountId);
  });

  test('TX-13 a legal old reservation settles after its batch expires while unreserved remainder expires', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, randomUUID());
    const chargeId = randomUUID();
    const grantId = randomUUID();
    await prepareExpiredReservedCharge(account.accountId, chargeId, grantId);

    const changed = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) =>
      credits.settle(chargeId));
    expect(changed).toBe(true);
    const entries = await isolated.runtime.pool.query<{
      kind: string; event_key: string; available_delta: string; reserved_delta: string; points_delta: string; expired_points: string;
    }>(`select kind, event_key, available_delta, reserved_delta, points_delta, expired_points
          from credit_ledger_entries where account_id = $1 order by sequence`, [account.accountId]);
    expect(entries.rows.slice(-2)).toEqual([
      { kind: 'expire', event_key: expect.stringMatching(/^expire:/u), available_delta: '-2', reserved_delta: '0', points_delta: '-2', expired_points: '2' },
      { kind: 'spend', event_key: `spend:${chargeId}`, available_delta: '0', reserved_delta: '-1', points_delta: '-1', expired_points: '0' },
    ]);
    const grant = await isolated.runtime.pool.query<{
      amount: string; reserved_amount: string; spent_amount: string; expired_amount: string;
    }>(`select amount, reserved_amount, spent_amount, expired_amount from credit_grants where id = $1::uuid`, [grantId]);
    expect(grant.rows[0]).toEqual({ amount: '3', reserved_amount: '0', spent_amount: '1', expired_amount: '2' });
    const balance = await inCreditTransaction(isolated.runtime.db, account.accountId, (credits) =>
      credits.balance(new Date()));
    expect(balance).toMatchObject({ available: 0, reserved: 0 });
    await assertLedgerAndGrantFormula(account.accountId);
  });

  test('TX-10 financial write refuses more than 100 pending expiries without partial funding, then batches reconcile', async () => {
    const account = await seedCreditAccount(isolated.runtime.db, randomUUID());
    await prepareExpiredGrantBatch(account.accountId, 101);
    const beforeSequence = await sequenceOf(account.accountId);
    await expect(grantCredits(isolated.runtime.db, {
      accountId: account.accountId,
      grantKey: `blocked-${randomUUID()}`,
      amount: 1,
      validFrom: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 86_400_000),
    })).rejects.toMatchObject({ code: 'P0001', message: 'credit_reconciliation_required' });
    expect(await countRows('credit_grants', account.accountId)).toBe(101);
    expect(await countRows('credit_ledger_entries', account.accountId)).toBe(101);
    expect(await sequenceOf(account.accountId)).toBe(beforeSequence);
    await assertLedgerAndGrantFormula(account.accountId, true);

    await expect(inCreditTransaction(
      isolated.runtime.db,
      account.accountId,
      (credits) => credits.reconcile(),
      { faultInjector: { afterCallbackBeforeCommit: () => { throw new Error('reconcile rollback'); } } },
    )).rejects.toThrow('reconcile rollback');
    expect(await countRows('credit_ledger_entries', account.accountId)).toBe(101);
    expect(await sequenceOf(account.accountId)).toBe(beforeSequence);
    const pendingAfterRollback = await pendingExpiryCount(account.accountId);
    expect(pendingAfterRollback).toBe(101);

    const first = await reconcileExpiredCredits(isolated.runtime.db, account.accountId) as {
      processed: number; has_more: boolean; last_sequence: string;
    };
    expect(first).toMatchObject({ processed: 100, has_more: true, last_sequence: '201' });
    await assertLedgerAndGrantFormula(account.accountId, true);
    const second = await reconcileExpiredCredits(isolated.runtime.db, account.accountId) as {
      processed: number; has_more: boolean; last_sequence: string;
    };
    expect(second).toMatchObject({ processed: 1, has_more: false, last_sequence: '202' });
    expect(await pendingExpiryCount(account.accountId)).toBe(0);
    await assertLedgerAndGrantFormula(account.accountId);
  });

  async function prepareMixedReservedCharge(accountId: string, chargeId: string, validGrantId: string, expiredGrantId: string): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_accounts(account_id,last_sequence,created_at) values ($1,3,$2::timestamptz)`,
      [accountId, HISTORICAL]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_grants(
        id,account_id,grant_key,fingerprint,amount,reserved_amount,spent_amount,expired_amount,
        valid_from,expires_at,source,reason_code,operator_note,created_at
      ) values
        ($2::uuid,$1,'grant:valid-mixed','mixed-valid',2,0,0,0,current_timestamp - interval '2 hours',current_timestamp + interval '1 day','operator','manual_grant','history',current_timestamp - interval '2 hours'),
        ($3::uuid,$1,'grant:expired-mixed','mixed-expired',1,1,0,0,current_timestamp - interval '2 days',current_timestamp - interval '1 hour','operator','manual_grant','history',current_timestamp - interval '2 days')`,
      [accountId, validGrantId, expiredGrantId]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_charges(
        id,account_id,operation_key,fingerprint,operation_type,source,price_version,quoted_amount,state,
        settled_amount,refunded_amount,task_kind,task_id,deadline_at,created_at
      ) values ($2::uuid,$1,'historical-mixed-charge','mixed-charge','bookmark.classify','web','bookmark-classify.v1',1,'reserved',0,0,
        'classification_preview',$2::text,current_timestamp + interval '1 day',current_timestamp - interval '2 hours')`,
      [accountId, chargeId]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_allocations(account_id,charge_id,grant_id,amount) values ($1,$2::uuid,$3::uuid,1)`,
      [accountId, chargeId, expiredGrantId]);
    await insertHistoricalEntries(accountId, [
      { sequence: 1, eventKey: `grant:${validGrantId}`, kind: 'grant', points: 2, available: 2, reserved: 0, grantId: validGrantId, chargeId: null, related: null, expires: null },
      { sequence: 2, eventKey: `grant:${expiredGrantId}`, kind: 'grant', points: 1, available: 1, reserved: 0, grantId: expiredGrantId, chargeId: null, related: null, expires: EXPIRED_U },
      { sequence: 3, eventKey: `reserve:${chargeId}`, kind: 'reserve', points: 0, available: -1, reserved: 1, grantId: null, chargeId, related: null, expires: null },
    ]);
  }

  async function prepareExpiredSettledCharge(accountId: string, chargeId: string, grantId: string): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_accounts(account_id,last_sequence,created_at) values ($1,3,$2::timestamptz)`,
      [accountId, HISTORICAL]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_grants(
        id,account_id,grant_key,fingerprint,amount,reserved_amount,spent_amount,expired_amount,
        valid_from,expires_at,source,reason_code,operator_note,created_at
      ) values ($2::uuid,$1,'grant:expired-settled','expired-settled',1,0,1,0,current_timestamp - interval '2 days',current_timestamp - interval '1 hour','operator','manual_grant','history',current_timestamp - interval '2 days')`,
      [accountId, grantId]);
    await insertCharge(accountId, chargeId, 'settled');
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_allocations(account_id,charge_id,grant_id,amount) values ($1,$2::uuid,$3::uuid,1)`,
      [accountId, chargeId, grantId]);
    await insertHistoricalEntries(accountId, [
      { sequence: 1, eventKey: `grant:${grantId}`, kind: 'grant', points: 1, available: 1, reserved: 0, grantId, chargeId: null, related: null, expires: EXPIRED_U },
      { sequence: 2, eventKey: `reserve:${chargeId}`, kind: 'reserve', points: 0, available: -1, reserved: 1, grantId: null, chargeId, related: null, expires: null },
      { sequence: 3, eventKey: `spend:${chargeId}`, kind: 'spend', points: -1, available: 0, reserved: -1, grantId: null, chargeId, related: null, expires: null },
    ]);
  }

  async function prepareExpiredReservedCharge(accountId: string, chargeId: string, grantId: string): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_accounts(account_id,last_sequence,created_at) values ($1,2,$2::timestamptz)`,
      [accountId, HISTORICAL]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_grants(
        id,account_id,grant_key,fingerprint,amount,reserved_amount,spent_amount,expired_amount,
        valid_from,expires_at,source,reason_code,operator_note,created_at
      ) values ($2::uuid,$1,'grant:expired-reserved','expired-reserved',3,1,0,0,current_timestamp - interval '2 days',current_timestamp - interval '1 hour','operator','manual_grant','history',current_timestamp - interval '2 days')`,
      [accountId, grantId]);
    await insertCharge(accountId, chargeId, 'reserved');
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_allocations(account_id,charge_id,grant_id,amount) values ($1,$2::uuid,$3::uuid,1)`,
      [accountId, chargeId, grantId]);
    await insertHistoricalEntries(accountId, [
      { sequence: 1, eventKey: `grant:${grantId}`, kind: 'grant', points: 3, available: 3, reserved: 0, grantId, chargeId: null, related: null, expires: EXPIRED_U },
      { sequence: 2, eventKey: `reserve:${chargeId}`, kind: 'reserve', points: 0, available: -1, reserved: 1, grantId: null, chargeId, related: null, expires: null },
    ]);
  }

  async function insertCharge(accountId: string, chargeId: string, state: 'reserved' | 'settled'): Promise<void> {
    const settled = state === 'settled' ? 1 : 0;
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_charges(
        id,account_id,operation_key,fingerprint,operation_type,source,price_version,quoted_amount,state,
        settled_amount,refunded_amount,task_kind,task_id,deadline_at,created_at,completed_at
      ) values ($2::uuid,$1,$3,$4,'bookmark.classify','web','bookmark-classify.v1',1,$5,$6,0,
        'classification_preview',$2::text,current_timestamp + interval '1 day',current_timestamp - interval '2 hours',
        case when $5='settled' then current_timestamp - interval '1 hour' else null end)`,
      [accountId, chargeId, `historical-${chargeId}`, `historical-fingerprint-${chargeId}`, state, settled]);
  }

  async function insertHistoricalEntries(accountId: string, rows: readonly HistoricalEntry[]): Promise<void> {
    let availableAfter = 0;
    let reservedAfter = 0;
    for (const row of rows) {
      availableAfter += row.available;
      reservedAfter += row.reserved;
      await executeWithoutPermanenceGuards(isolated.runtime.pool,
        `insert into credit_ledger_entries(
          id,account_id,sequence,event_key,fingerprint,kind,posted_at,effective_at,points_delta,
          available_delta,reserved_delta,expired_points,available_after,reserved_after,operation_type,
          source,reason_code,grant_id,charge_id,related_entry_id,expires_at,task_json
        ) values ($2::uuid,$1,$3,$4,$5,$6,current_timestamp - interval '1 hour',current_timestamp - interval '1 hour',
          $7,$8,$9,$10,$11,$12,$13,'operator',$14,$15::uuid,$16::uuid,$17::uuid,$18::timestamptz,null)`,
        [
          accountId, randomUUID(), row.sequence, row.eventKey, `history-${row.sequence}-${row.eventKey}`,
          row.kind, row.points, row.available, row.reserved,
          0,
          availableAfter, reservedAfter,
          row.kind === 'grant' ? 'credit.grant' : 'bookmark.classify',
          row.kind === 'grant' ? 'manual_grant' : row.kind === 'reserve' ? 'classification_requested' : 'classification_completed',
          row.grantId, row.chargeId, row.related, row.expires,
        ]);
    }
  }

  async function prepareExpiredGrantBatch(accountId: string, count: number): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_accounts(account_id,last_sequence,created_at) values ($1,0,$2::timestamptz)`,
      [accountId, HISTORICAL]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `insert into credit_grants(
        id,account_id,grant_key,fingerprint,amount,reserved_amount,spent_amount,expired_amount,
        valid_from,expires_at,source,reason_code,operator_note,created_at
      ) select gen_random_uuid(),$1,'grant:batch-expired-' || n,'batch-expired-' || n,1,0,0,0,
        current_timestamp - interval '2 days',current_timestamp - interval '1 hour','operator','manual_grant','history',current_timestamp - interval '2 days'
        from generate_series(1,$2::integer) as series(n)`,
      [accountId, count]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `with ordered as (
        select id,row_number() over(order by id)::bigint as sequence
          from credit_grants where account_id=$1
      ) insert into credit_ledger_entries(
        id,account_id,sequence,event_key,fingerprint,kind,posted_at,effective_at,points_delta,
        available_delta,reserved_delta,expired_points,available_after,reserved_after,operation_type,
        source,reason_code,grant_id,charge_id,related_entry_id,expires_at,task_json
      ) select gen_random_uuid(),$1,sequence,'grant:' || id::text,'batch-entry-' || sequence,'grant',
        current_timestamp - interval '1 hour',current_timestamp - interval '1 hour',1,1,0,0,sequence,0,
        'credit.grant','operator','manual_grant',id,null,null,current_timestamp - interval '1 hour',null
        from ordered`,
      [accountId]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `update credit_accounts set last_sequence=$2 where account_id=$1`, [accountId, count]);
  }

  async function assertLedgerAndGrantFormula(accountId: string, allowPendingExpired = false): Promise<void> {
    const entries = await isolated.runtime.pool.query<{
      sequence: string; points_delta: string; available_delta: string; reserved_delta: string;
      available_after: string; reserved_after: string;
    }>(`select sequence,points_delta,available_delta,reserved_delta,available_after,reserved_after
          from credit_ledger_entries where account_id=$1 order by sequence`, [accountId]);
    let available = 0n;
    let reserved = 0n;
    for (const entry of entries.rows) {
      const availableDelta = BigInt(entry.available_delta);
      const reservedDelta = BigInt(entry.reserved_delta);
      available += availableDelta;
      reserved += reservedDelta;
      expect(BigInt(entry.points_delta)).toBe(availableDelta + reservedDelta);
      expect(BigInt(entry.available_after)).toBe(available);
      expect(BigInt(entry.reserved_after)).toBe(reserved);
    }
    const formula = await isolated.runtime.pool.query<{ available: string; reserved: string; pending: string }>(
      `select
         coalesce(sum(case when valid_from <= current_timestamp and (expires_at is null or current_timestamp < expires_at)
           then amount-reserved_amount-spent_amount-expired_amount else 0 end),0)::text as available,
         coalesce(sum(reserved_amount),0)::text as reserved,
         coalesce(sum(case when expires_at <= current_timestamp and expiry_processed_at is null
           then amount-reserved_amount-spent_amount-expired_amount else 0 end),0)::text as pending
         from credit_grants where account_id=$1`, [accountId]);
    const facts = formula.rows[0]!;
    const pending = BigInt(facts.pending);
    if (allowPendingExpired) {
      expect(available - BigInt(facts.available)).toBe(pending);
    } else {
      expect(available).toBe(BigInt(facts.available));
    }
    expect(reserved).toBe(BigInt(facts.reserved));
  }

  async function sequenceOf(accountId: string): Promise<string> {
    const row = await isolated.runtime.pool.query<{ last_sequence: string }>(
      `select last_sequence::text from credit_accounts where account_id=$1`, [accountId]);
    return row.rows[0]?.last_sequence ?? '0';
  }

  async function pendingExpiryCount(accountId: string): Promise<number> {
    const row = await isolated.runtime.pool.query<{ pending: string }>(
      `select count(*)::text as pending from credit_grants
        where account_id=$1 and expires_at <= current_timestamp and expiry_processed_at is null`, [accountId]);
    return Number(row.rows[0]?.pending ?? '0');
  }

  async function countRows(table: 'credit_grants' | 'credit_ledger_entries', accountId: string): Promise<number> {
    const row = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from ${table} where account_id=$1`, [accountId]);
    return Number(row.rows[0]?.count ?? '0');
  }
});

interface HistoricalEntry {
  readonly sequence: number;
  readonly eventKey: string;
  readonly kind: 'grant' | 'reserve' | 'spend';
  readonly points: number;
  readonly available: number;
  readonly reserved: number;
  readonly grantId: string | null;
  readonly chargeId: string | null;
  readonly related: string | null;
  readonly expires: string | null;
}
