import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import type { LocalReceiptInput } from '@know-n/colp/automation';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork, createAutomationRuntime } from '../../../src/infrastructure/automation/index.js';
import { createPostgresReplicaLifecycleService } from '../../../src/infrastructure/sync/index.js';
import { acceptIntakeReceipt, placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';

describeWithPostgres('bounded durable receipt queue', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  beforeEach(async () => { f = await automationDeviceFixture('receipt_queue'); });
  afterEach(async () => { await f?.isolated.close(); });

  const device = () => createAutomationDeviceUnitOfWork(f.db, 'server');
  const authority = () => ({ credential: f.http.credential, sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN });
  const accept = (input: LocalReceiptInput) => device().execute(authority(), ports => acceptIntakeReceipt(ports, input));
  function receipt(nodeId: string, operationId: string, bundleRevision = '1'): LocalReceiptInput {
    const identity = { committedNode: { ...f.folder, nodeId }, ruleRevision: '1', bindingRevision: '1' };
    return { ...identity, deviceId: f.replica.deviceId, replicaGeneration: Number(f.replica.leaseGeneration),
      localReceiptId: randomUUID(), operationId, ruleId: f.rule.id, bundleRevision,
      inputDigest: placementInputDigest(identity, { url: 'https://arxiv.org/sync', title: 'Sync paper', tags: [] }),
      resultDigests: [placementResultDigest(f.folder)], satisfiedTaskTypes: ['classify.root'] };
  }
  async function waitingCount() {
    return Number((await sql<{ count: string }>`SELECT count(*) FROM automation_intake_receipts
      WHERE owner_id=${f.owner.accountId} AND state='waitingForSync'`.execute(f.db)).rows[0]!.count);
  }
  async function fillWaiting(total: number) {
    const original = await accept(receipt('pending-node', 'never-arriving-operation'));
    expect(original.state).toBe('waitingForSync');
    // Capacity fixture only: clone validated WAITING rows. No canonical facts,
    // accepted receipt, run or effect is fabricated by this bulk setup.
    await sql`WITH original AS (SELECT * FROM automation_intake_receipts WHERE id=${original.receiptId})
      INSERT INTO automation_intake_receipts(id,owner_id,device_id,replica_generation,local_receipt_id,operation_id,state,receipt_json)
      SELECT 'queued-'||n,owner_id,device_id,replica_generation,'queued-'||n,'queued-operation-'||n,'waitingForSync',
        receipt_json || jsonb_build_object(
          'input',receipt_json->'input' || jsonb_build_object('localReceiptId','queued-'||n,'operationId','queued-operation-'||n),
          'result',receipt_json->'result' || jsonb_build_object('receiptId','queued-'||n))
      FROM original CROSS JOIN generate_series(1,${total - 1}) AS n`.execute(f.db);
    expect(await waitingCount()).toBe(total);
    return original.receiptId;
  }

  test('full waiting quota does not reject a new receipt whose canonical proof is complete', async () => {
    await fillWaiting(1000);
    await f.syncCreate('complete-node', 'complete-operation');
    const input = receipt('complete-node', 'complete-operation');
    const result = await accept(input);
    expect(result).toMatchObject({ state: 'accepted', satisfiedTaskTypes: ['classify.root'] });
    expect(await accept(input)).toEqual(result);
    expect(await waitingCount()).toBe(1000);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(1);
  });

  test('Owner serialization admits only one of two concurrent new waits at the quota boundary', async () => {
    await fillWaiting(999);
    const results = await Promise.allSettled([
      accept(receipt('pending-a', 'pending-operation-a')),
      accept(receipt('pending-b', 'pending-operation-b')),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'payload_too_large' });
    expect(await waitingCount()).toBe(1000);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toEqual([]);
  });

  test('expired bundle waits release capacity without rewriting their original evidence', async () => {
    const id = await fillWaiting(1000);
    const before = (await sql<{ input: unknown }>`SELECT receipt_json->'input' AS input FROM automation_intake_receipts WHERE id=${id}`.execute(f.db)).rows[0]!.input;
    // Inject expiry, not a forged accepted effect. Issue the replacement bundle
    // through the authenticated device unit of work.
    await sql`UPDATE automation_device_bundles SET expires_at=clock_timestamp()-interval '1 second'
      WHERE owner_id=${f.owner.accountId} AND revision=1`.execute(f.db);
    const bundle = await device().execute(authority(), ports => ports.bundle('browser-bounded-v1'));
    expect((await accept(receipt('new-pending', 'new-operation', bundle.revision))).state).toBe('waitingForSync');
    expect(await waitingCount()).toBe(1);
    const previous = (await sql<{ state: string; input: unknown; code: string }>`SELECT state,receipt_json->'input' AS input,
      receipt_json#>>'{result,diagnostics,0,code}' AS code FROM automation_intake_receipts WHERE id=${id}`.execute(f.db)).rows[0]!;
    expect(previous).toEqual({ state: 'review', input: before, code: 'bundleExpired' });
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_intake_receipts WHERE state='review'`.execute(f.db)).rows[0]!.count).toBe('1000');
  });

  test('retiring a replica releases its waiting evidence without any missing operation arriving', async () => {
    const input = receipt('never-created', 'never-committed');
    const result = await accept(input);
    const current = await f.db.selectFrom('sync_replicas').select(['lease_generation', 'lifecycle_revision'])
      .where('replica_id', '=', f.replica.replicaId).executeTakeFirstOrThrow();
    const retired = await createPostgresReplicaLifecycleService(f.db, { auditPrincipalId: f.owner.accountId }).retire({
      scope: { accountId: f.owner.accountId, collectionId: 'collection', replicaId: f.replica.replicaId,
        expectedLeaseGeneration: String(current.lease_generation), expectedLifecycleRevision: String(current.lifecycle_revision) },
      outcome: 'authorized_success',
    });
    expect(retired.state).toBe('committed');
    await f.inspect();
    expect(await waitingCount()).toBe(0);
    const row = (await sql<{ state: string; input: unknown; code: string }>`SELECT state,receipt_json->'input' AS input,
      receipt_json#>>'{result,diagnostics,0,code}' AS code FROM automation_intake_receipts WHERE id=${result.receiptId}`.execute(f.db)).rows[0]!;
    expect(row).toEqual({ state: 'review', input, code: 'generationChanged' });
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
  });

  test('empty-source runtime wake drains multiple bounded receipt slices after the cursor already passed', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 13; index++) {
      const nodeId = `late-${index}`, operationId = `late-operation-${index}`;
      ids.push((await accept(receipt(nodeId, operationId))).receiptId);
      await f.syncCreate(nodeId, operationId);
    }
    // This models the installed inspection-only composition: canonical positions
    // advance without running the receipt consumer, using the real source UoW.
    await f.inspect(async () => {});
    expect(await waitingCount()).toBe(13);
    await f.inspect(createAutomationRuntime('server'));
    expect(await waitingCount()).toBe(0);
    const rows = (await sql<{ state: string }>`SELECT state FROM automation_intake_receipts WHERE id=ANY(${ids}::text[])`.execute(f.db)).rows;
    expect(rows).toHaveLength(13);
    expect(rows.every(row => row.state === 'accepted')).toBe(true);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(13);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(13);
    await f.inspect(createAutomationRuntime('server'));
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(13);
  });
});
