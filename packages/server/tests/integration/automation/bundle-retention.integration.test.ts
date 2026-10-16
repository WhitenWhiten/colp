import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationDigest } from '@know-n/colp/automation';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { retainAutomationHistory } from '../../../src/infrastructure/automation/retention-worker.js';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('device bundle reuse and evidence retention', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  const bundle = () => createAutomationDeviceUnitOfWork(f.db, 'server').execute({
    credential: f.http.credential, sessionId: f.sessionId, origin: AUTOMATION_DEVICE_ORIGIN,
  }, p => p.bundle('browser-bounded-v1'));

  test('unchanged polls reuse a snapshot, renew before expiry and recheck live folder authority', async () => {
    f = await automationDeviceFixture('bundle_reuse');
    const first = await bundle();
    for (let n = 0; n < 20; n++) expect(await bundle()).toEqual(first);
    expect((await sql`SELECT revision FROM automation_device_bundles`.execute(f.db)).rows).toHaveLength(1);
    const { digest: _digest, ...content } = first;
    const issued = new Date(Date.now() - 25 * 60 * 60_000);
    const agedContent = { ...content, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + 7 * 24 * 60 * 60_000).toISOString() };
    const aged = { ...agedContent, digest: automationDigest(agedContent) };
    await sql`UPDATE automation_device_bundles SET issued_at=${issued},expires_at=${new Date(aged.expiresAt)},
      digest=${aged.digest},snapshot_json=${JSON.stringify(aged)}::jsonb`.execute(f.db);
    const renewed = await bundle();
    expect(renewed.revision).toBe('2');
    expect(renewed.rules).toEqual(first.rules);
    await sql`UPDATE automation_device_bundles SET expires_at=clock_timestamp()+interval '1 hour' WHERE revision=2`.execute(f.db);
    expect((await bundle()).revision).toBe('3');
    await sql`UPDATE nodes SET deleted_at=clock_timestamp() WHERE id='academic'`.execute(f.db);
    const unavailable = await bundle();
    expect(unavailable).toMatchObject({ revision: '4', rules: [], removedRuleIds: [f.rule.id] });
    expect(await bundle()).toEqual(unavailable);
    await sql`UPDATE nodes SET deleted_at=NULL WHERE id='academic'`.execute(f.db);
    expect((await bundle()).rules).toEqual(first.rules);
  });

  test('bounded M1 housekeeping keeps receipt evidence, recent snapshots, owner isolation and revision monotonicity', async () => {
    f = await automationDeviceFixture('bundle_retention');
    const other = await f.issue('other');
    await sql`UPDATE automation_device_bundles SET expires_at=clock_timestamp()-interval '40 days'`.execute(f.db);
    await sql`INSERT INTO automation_device_bundles(owner_id,device_id,revision,profile,digest,issued_at,expires_at,paused,settings_revision,status,snapshot_json)
      SELECT b.owner_id,b.device_id,n,b.profile,b.digest,b.issued_at,b.expires_at,b.paused,b.settings_revision,b.status,b.snapshot_json
      FROM automation_device_bundles b CROSS JOIN generate_series(2,506) n`.execute(f.db);
    await sql`UPDATE automation_device_bundles SET expires_at=clock_timestamp()-interval '1 day' WHERE revision=505`.execute(f.db);
    await sql`INSERT INTO automation_device_bundles(owner_id,device_id,revision,profile,digest,issued_at,expires_at,paused,settings_revision,status,snapshot_json)
      SELECT ${other.accountId},b.device_id,b.revision,b.profile,b.digest,b.issued_at,b.expires_at,b.paused,b.settings_revision,b.status,b.snapshot_json
      FROM automation_device_bundles b WHERE revision IN (1,2)`.execute(f.db);
    await sql`INSERT INTO automation_intake_receipts(id,owner_id,device_id,replica_generation,local_receipt_id,operation_id,state,receipt_json)
      VALUES('referenced',${f.owner.accountId},${f.replica.deviceId},1,'referenced','historical-operation','accepted',
        '{"input":{"bundleRevision":"1"}}'::jsonb)`.execute(f.db);
    const revisions = async () => (await sql<{ revision: string }>`SELECT revision::text FROM automation_device_bundles
      WHERE owner_id=${f.owner.accountId} ORDER BY revision`.execute(f.db)).rows.map(row => row.revision);
    await retainAutomationHistory(f.db, f.owner.accountId, false);
    expect(await revisions()).toHaveLength(6); // At most 500 of 503 eligible snapshots per pass.
    await retainAutomationHistory(f.db, f.owner.accountId, false);
    expect(await revisions()).toEqual(['1', '505', '506']);
    expect((await sql`SELECT revision FROM automation_device_bundles WHERE owner_id=${other.accountId}`.execute(f.db)).rows).toHaveLength(2);
    expect((await sql`SELECT id FROM automation_intake_receipts WHERE id='referenced'`.execute(f.db)).rows).toHaveLength(1);
    expect((await bundle()).revision).toBe('507');
  });
});
