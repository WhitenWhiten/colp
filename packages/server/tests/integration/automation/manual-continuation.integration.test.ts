import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { claimManualDelivery, deliverManualSlice, drainManualRuns } from '../../support/manual-run-delivery.js';
import { createManualRunConsumer } from '../../../src/infrastructure/automation/manual-run-consumer.js';

describeWithPostgres('Durable manual continuation', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  async function start(prefix: string) {
    f = await automationRuntimeFixture(prefix, true);
    for (let i = 1; i < 25; i++) await f.createNode(`member-${i}`, 'root', 'Paper', `https://arxiv.org/${i}`);
    const preview = await f.uow.execute(f.owner, p => p.runOnce!.preview(f.rule.id, {
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' },
      includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none',
    }));
    const run = await f.uow.execute(f.owner, p => p.runOnce!.start(f.rule.id, { previewId: preview.id, previewDigest: preview.previewDigest }));
    expect(run.status).toBe('running'); expect(run.childRunIds).toHaveLength(25);
    expect(await effectCount()).toBe(0);
    return { run, preview };
  }
  const effectCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_effect_receipts`.execute(f.db)).rows[0]!.n;
  const nextNode = async () => (await sql<{ id: string }>`SELECT explanation_json->>'nodeId' AS id FROM automation_runs
    WHERE explanation_json->>'manualPending'='true' AND explanation_json ? 'parentRunId'
    ORDER BY (explanation_json->>'manualIndex')::int LIMIT 1`.execute(f.db)).rows[0]!.id;
  const load = (id: string) => f.uow.execute(f.owner, p => p.runs.load(id));

  test('commits bounded slices, respects pause, skips changed members and never adds newly saved members', async () => {
    const { run, preview } = await start('manual_continuation');
    await deliverManualSlice(f.db); expect(await effectCount()).toBe(10);
    const changed = await nextNode(); await f.rename(changed, 'Owner edit after admission');
    await f.createNode('later-save', 'root', 'New save', 'https://arxiv.org/later');
    await f.uow.execute(f.owner, async p => p.settings.save(f.owner.accountId,
      { ...(await p.settings.get(f.owner.accountId)), paused: true, pausedAt: new Date().toISOString(), pausedBy: 'owner', revision: '1' }));
    await deliverManualSlice(f.db); expect(await effectCount()).toBe(10);
    await f.uow.execute(f.owner, async p => p.settings.save(f.owner.accountId,
      { ...(await p.settings.get(f.owner.accountId)), paused: false, pausedAt: null, pausedBy: null, revision: '2' }));
    await drainManualRuns(f.db);
    expect(await effectCount()).toBe(24); expect((await load(run.id))!.view.status).toBe('partial');
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', changed).executeTakeFirst())?.parent_id).toBe('root');
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'later-save').executeTakeFirst())?.parent_id).toBe('root');
    const replay = await f.uow.execute(f.owner, p => p.runOnce!.start(f.rule.id, { previewId: preview.id, previewDigest: preview.previewDigest }));
    expect(replay.id).toBe(run.id); expect(replay.childRunIds).toHaveLength(25);
    await drainManualRuns(f.db); expect(await effectCount()).toBe(24);
  });

  test('a failed slice rolls back only that slice and retry keeps the committed prefix exactly once', async () => {
    const { run } = await start('manual_chunk_failure');
    await deliverManualSlice(f.db); expect(await effectCount()).toBe(10);
    const nodeId = await nextNode();
    await sql`CREATE TABLE manual_rejected_node(id text PRIMARY KEY)`.execute(f.db);
    await sql`INSERT INTO manual_rejected_node VALUES(${nodeId})`.execute(f.db);
    await sql`CREATE FUNCTION reject_manual_slice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM manual_rejected_node WHERE id=NEW.node_id) THEN RAISE EXCEPTION 'manual slice failure'; END IF; RETURN NEW; END $$`.execute(f.db);
    await sql`CREATE TRIGGER reject_manual_slice BEFORE INSERT ON automation_effect_receipts FOR EACH ROW EXECUTE FUNCTION reject_manual_slice()`.execute(f.db);
    await expect(deliverManualSlice(f.db)).rejects.toThrow('manual slice failure');
    expect(await effectCount()).toBe(10);
    expect((await f.db.selectFrom('nodes').select('id').where('parent_id', '=', 'academic').execute())).toHaveLength(10);
    await sql`DROP TRIGGER reject_manual_slice ON automation_effect_receipts`.execute(f.db);
    await drainManualRuns(f.db);
    expect(await effectCount()).toBe(25); expect((await load(run.id))!.view.status).toBe('completed');
    expect((await sql`SELECT operation_id FROM automation_effect_receipts GROUP BY operation_id HAVING count(*)>1`.execute(f.db)).rows).toEqual([]);
  });

  test('a lost lease rolls back the current slice; a new lease resumes safely', async () => {
    await start('manual_lease_fence');
    const stale = (await claimManualDelivery(f.db))!;
    await f.db.updateTable('outbox_events').set({ lease_generation: sql<bigint>`lease_generation+1` })
      .where('outbox_id', '=', stale.attempt!.outboxId).execute();
    await expect(createManualRunConsumer(f.db, 'server')(stale)).rejects.toThrow('lease lost');
    expect(await effectCount()).toBe(0);
    await f.db.updateTable('outbox_events').set({ state: 'pending', locked_until: null })
      .where('outbox_id', '=', stale.attempt!.outboxId).execute();
    await drainManualRuns(f.db); expect(await effectCount()).toBe(25);
  });

  test('cancelling retains the committed prefix and stops every pending child', async () => {
    const { run } = await start('manual_cancel_prefix');
    await deliverManualSlice(f.db); expect(await effectCount()).toBe(10);
    await f.uow.execute(f.owner, p => p.runs.cancel(run.id));
    await drainManualRuns(f.db);
    expect(await effectCount()).toBe(10); expect((await load(run.id))!.view.status).toBe('cancelled');
  });

  test('ownership loss stops remaining effects without erasing committed placements', async () => {
    const { run } = await start('manual_owner_loss');
    await deliverManualSlice(f.db); expect(await effectCount()).toBe(10);
    const nextOwner = await f.issue('next-owner');
    await sql`UPDATE collections SET owner_subject_id=${nextOwner.subjectId},
      payload_json=jsonb_set(payload_json,'{ownerSubjectId}',to_jsonb(${nextOwner.subjectId}::text)) WHERE id='collection'`.execute(f.db);
    await drainManualRuns(f.db);
    expect(await effectCount()).toBe(10); expect(await load(run.id)).toBeNull();
    expect((await sql`SELECT id FROM automation_runs WHERE explanation_json->>'parentRunId'=${run.id} AND state='review'`.execute(f.db)).rows).toHaveLength(15);
  });
});
