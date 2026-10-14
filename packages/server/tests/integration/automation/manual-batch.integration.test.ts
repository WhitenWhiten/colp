import { afterEach, expect, test } from 'vitest';
import { sql, type KyselyPlugin } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { recordPlacementHistories } from '../../../src/infrastructure/automation/placement-history-store.js';
import { measureCanonicalTree } from '../../../src/infrastructure/collections/canonical-tree-capacity.js';
import { readCanonicalTreeCapacity } from '../../../src/infrastructure/collections/canonical-tree-capacity-ledger.js';

describeWithPostgres('Atomic manual placement batches', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  const options = { folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none' };
  const preview = () => f.uow.execute(f.owner, p => p.runOnce!.preview(f.rule.id, options));

  test('twenty placements preserve exact capacity accounting with a bounded query budget and stable receipt replay', async () => {
    f = await automationRuntimeFixture('manual_batch_budget', true);
    for (let i = 1; i < 20; i++) await f.createNode(`member-${i}`, 'root', 'Paper', `https://arxiv.org/${i}`);
    const p = await preview(); expect(p.canStart).toBe(true); expect(p.matchedCount).toBe(20);
    let queries = 0;
    const plugin: KyselyPlugin = { transformQuery: ({ node }) => { queries++; return node; }, transformResult: async ({ result }) => result };
    const uow = createAutomationUnitOfWork(f.db.withPlugin(plugin), 'server', { runtimeEnabled: true });
    const started = await uow.execute(f.owner, ports => ports.runOnce!.start(f.rule.id, { previewId: p.id, previewDigest: p.previewDigest }));
    expect(started.childRunIds).toHaveLength(20);
    expect(queries).toBeLessThan(800); // Previous batch adapter: 928; retain every operation's evidence.
    expect(await f.db.selectFrom('nodes').select('id').where('parent_id', '=', 'academic').execute()).toHaveLength(20);
    await f.db.transaction().execute(async tx => {
      expect((await sql`SELECT node_id FROM canonical_tree_capacity_dirty WHERE collection_id='collection'`.execute(tx)).rows).toEqual([]);
      expect(await readCanonicalTreeCapacity(tx, 'collection')).toEqual(await measureCanonicalTree(tx, 'collection'));
      const effects = (await sql<{ id: string; run_id: string; operation_id: string; effect_digest: string }>`SELECT id,run_id,operation_id,effect_digest
        FROM automation_effect_receipts ORDER BY id`.execute(tx)).rows;
      expect(effects).toHaveLength(20);
      const replayed = await recordPlacementHistories(tx, f.owner, 'server', effects.map(e => ({ runId: e.run_id, operationId: e.operation_id })));
      expect(replayed).toEqual(effects.map(e => ({ id: e.id, inserted: false })));
      expect((await sql`SELECT id,run_id,operation_id,effect_digest FROM automation_effect_receipts ORDER BY id`.execute(tx)).rows).toEqual(effects);
    });
  });

  test('a suppressed parent write rolls back the complete manual move', async () => {
    f = await automationRuntimeFixture('manual_parent_rollback', true);
    const p = await preview();
    const before = await f.db.selectFrom('nodes').selectAll().orderBy('id').execute();
    await sql`CREATE FUNCTION suppress_batch_parent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='academic' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(f.db);
    await sql`CREATE TRIGGER suppress_batch_parent BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION suppress_batch_parent()`.execute(f.db);
    await expect(f.uow.execute(f.owner, ports => ports.runOnce!.start(f.rule.id, { previewId: p.id, previewDigest: p.previewDigest })))
      .rejects.toMatchObject({ code: 'resource_field_authority_violation' });
    expect(await f.db.selectFrom('nodes').selectAll().orderBy('id').execute()).toEqual(before);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
  });

  test('a failed receipt insert rolls back every move, run, reservation and outbox event', async () => {
    f = await automationRuntimeFixture('manual_batch_rollback', true);
    await f.createNode('second', 'root', 'Second', 'https://arxiv.org/second');
    const p = await preview();
    const before = await f.db.selectFrom('nodes').select(['id', 'parent_id', 'resource_revision']).orderBy('id').execute();
    const outbox = await f.db.selectFrom('outbox_events').select('outbox_id').orderBy('outbox_id').execute();
    await sql`CREATE FUNCTION reject_batch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.node_id='second' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$`.execute(f.db);
    await sql`CREATE TRIGGER reject_batch_receipt BEFORE INSERT ON automation_effect_receipts FOR EACH ROW EXECUTE FUNCTION reject_batch_receipt()`.execute(f.db);
    const start = () => f.uow.execute(f.owner, ports => ports.runOnce!.start(f.rule.id, { previewId: p.id, previewDigest: p.previewDigest }));
    await expect(start()).rejects.toMatchObject({ kind: 'database_failure', cause: { message: 'injected receipt failure' } });
    expect(await f.db.selectFrom('nodes').select(['id', 'parent_id', 'resource_revision']).orderBy('id').execute()).toEqual(before);
    expect(await f.db.selectFrom('outbox_events').select('outbox_id').orderBy('outbox_id').execute()).toEqual(outbox);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toEqual([]);
    await sql`DROP TRIGGER reject_batch_receipt ON automation_effect_receipts`.execute(f.db);
    expect((await start()).childRunIds).toHaveLength(2);
  });
});
