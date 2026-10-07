import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresProductCommandReceiptPort } from '../../../src/infrastructure/database/product-command-receipt.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { createPostgresCreditHealthObserver } from '../../../src/infrastructure/identity/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createCreditTestDatabase, grantCredits, inCreditTransaction, seedCreditAccount } from '../../support/credit-ledger-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('CR06 credit reconciliation and account admission quarantine', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_integrity');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());
  const audit = (accountId: string, clear = false) => sql<{ issue_code: string; issue_count: string }>`SELECT * FROM credit_audit_account(${accountId},${clear})`.execute(isolated.runtime.db);
  const reserve = (accountId: string, id = randomUUID()) => inCreditTransaction(isolated.runtime.db, accountId, credits => credits.reserve({
    chargeId: id, operationKey: id, fingerprint: id, amount: 1, source: 'web', priceVersion: 'bookmark-classify.v1',
    ownerKind: 'classification_preview', ownerId: id,
    task: { kind: 'classification_preview', collectionId: 'missing-owner', nodeId: null, runId: null, actionId: null },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }));

  test('detects a missing charge owner and blocks new reserves while allowing existing release and funding', async () => {
    const { accountId } = await seedCreditAccount(isolated.runtime.db, 'orphan-owner');
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'initial', amount: 5 });
    expect((await audit(accountId)).rows).toEqual([]);
    const held = await reserve(accountId);
    expect((await audit(accountId)).rows).toEqual([{ issue_code: 'orphan_hold', issue_count: '1' }]);
    await expect(reserve(accountId)).rejects.toMatchObject({code:'credits_unavailable',cause:{code:'P0001',message:'credit_integrity_blocked'}});
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'manual-after-alert', amount: 1 });
    expect((await sql<{repaired:boolean}>`SELECT credit_repair_orphan_hold(${accountId},${held}::uuid) AS repaired`.execute(isolated.runtime.db)).rows[0]?.repaired).toBe(true);
    expect((await sql<{repaired:boolean}>`SELECT credit_repair_orphan_hold(${accountId},${held}::uuid) AS repaired`.execute(isolated.runtime.db)).rows[0]?.repaired).toBe(false);
    expect((await audit(accountId)).rows).toEqual([]);
    await expect(reserve(accountId)).rejects.toMatchObject({code:'credits_unavailable',cause:{code:'P0001',message:'credit_integrity_blocked'}});
    expect((await audit(accountId, true)).rows).toEqual([]);
    const fresh = await reserve(accountId);
    await inCreditTransaction(isolated.runtime.db, accountId, credits => credits.release(fresh, 'classification_failed'));
    expect((await audit(accountId)).rows).toEqual([]);
  });

  test('detects independent ledger and grant corruption without rewriting financial history', async () => {
    const { accountId } = await seedCreditAccount(isolated.runtime.db, 'corrupted');
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'initial', amount: 5 });
    const original = await isolated.runtime.db.selectFrom('credit_ledger_entries').selectAll().where('account_id', '=', accountId).execute();
    // An administrator bypass simulates corruption; application roles cannot perform it.
    await isolated.runtime.db.transaction().execute(async tx => {
      await sql`ALTER TABLE credit_grants DISABLE TRIGGER credit_grants_mutation_guard`.execute(tx);
      await sql`UPDATE credit_grants SET spent_amount=1 WHERE account_id=${accountId}`.execute(tx);
      await sql`ALTER TABLE credit_grants ENABLE TRIGGER credit_grants_mutation_guard`.execute(tx);
    });
    const issues = (await audit(accountId, true)).rows.map(row => row.issue_code);
    expect(issues).toContain('grant_counters');
    expect(issues).toContain('ledger_head');
    const blocked = await isolated.runtime.db.selectFrom('credit_accounts').select('integrity_blocked').where('account_id', '=', accountId).executeTakeFirstOrThrow();
    expect(blocked.integrity_blocked).toBe(true);
    expect(await isolated.runtime.db.selectFrom('credit_ledger_entries').selectAll().where('account_id', '=', accountId).execute()).toEqual(original);
  });

  test('controlled orphan repair preserves the operation fence and a stable receipt', async () => {
    const { accountId } = await seedCreditAccount(isolated.runtime.db, 'orphan-receipt');
    await grantCredits(isolated.runtime.db, { accountId, grantKey: 'initial', amount: 1 });
    const commandScope = 'collections:classification-preview:v1';
    const commandId = randomUUID();
    const operationKey = JSON.stringify([commandScope, commandId]);
    const fingerprint = `repair-${randomUUID()}`;
    const chargeId = randomUUID();
    const task = { kind: 'classification_preview' as const, collectionId: 'missing-owner', nodeId: null, runId: null, actionId: null };
    await inCreditTransaction(isolated.runtime.db, accountId, credits => credits.reserve({
      chargeId, operationKey, fingerprint, amount: 1, source: 'web', priceVersion: 'bookmark-classify.v1',
      ownerKind: 'classification_preview', ownerId: chargeId, task,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const receipts = createPostgresProductCommandReceiptPort(transaction);
      expect(await receipts.claim({ principalId: accountId, commandScope, commandId }, fingerprint)).toMatchObject({ kind: 'claimed' });
    });
    const first = await sql<{ repaired: boolean }>`SELECT credit_repair_orphan_hold(${accountId},${chargeId}::uuid) AS repaired`.execute(isolated.runtime.db);
    expect(first.rows[0]?.repaired).toBe(true);
    const receipt = await isolated.runtime.db.selectFrom('product_command_receipts').select(['result_status', 'result_bytes', 'result_digest'])
      .where('principal_id', '=', accountId).where('command_scope', '=', commandScope).where('command_id', '=', commandId).executeTakeFirstOrThrow();
    expect(receipt.result_status).toBe(503);
    expect(receipt.result_bytes).not.toBeNull();expect(receipt.result_digest).not.toBeNull();
    const replay = await inCreditTransaction(isolated.runtime.db, accountId, credits => credits.reserve({
      chargeId: randomUUID(), operationKey, fingerprint, amount: 1, source: 'web', priceVersion: 'bookmark-classify.v1',
      ownerKind: 'classification_preview', ownerId: randomUUID(), task,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(replay).toBe(chargeId);
    expect((await isolated.runtime.db.selectFrom('credit_charges').select(['id', 'state']).where('account_id', '=', accountId).execute()))
      .toEqual([{ id: chargeId, state: 'released' }]);
    const bytes = Buffer.from(receipt.result_bytes!);
    expect((await sql<{ repaired: boolean }>`SELECT credit_repair_orphan_hold(${accountId},${chargeId}::uuid) AS repaired`.execute(isolated.runtime.db)).rows[0]?.repaired).toBe(false);
    const after = await isolated.runtime.db.selectFrom('product_command_receipts').select('result_bytes')
      .where('principal_id', '=', accountId).where('command_scope', '=', commandScope).where('command_id', '=', commandId).executeTakeFirstOrThrow();
    expect(Buffer.from(after.result_bytes!)).toEqual(bytes);
  });

  test('observer reports durable money events and anomalies without account metric labels', async () => {
    const metrics = new InMemoryMetrics();
    await createPostgresCreditHealthObserver(isolated.runtime.db, metrics)();
    expect(metrics.get('classification.credits.reserved_total')).toBe(3);
    expect(metrics.get('classification.credits.released_total')).toBe(3);
    expect(metrics.get('classification.credits.outstanding_holds')).toBe(0);
    expect(metrics.get('classification.credits.integrity_alerts')).toBeGreaterThan(0);
    expect(metrics.get('classification.credits.audit_failed')).toBe(0);
  });
});
