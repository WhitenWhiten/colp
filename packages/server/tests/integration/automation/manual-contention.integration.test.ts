import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { lockCollectionReplicaGate } from '../../../src/infrastructure/database/lock-order.js';
import { createManualRunConsumer } from '../../../src/infrastructure/automation/manual-run-consumer.js';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { claimManualDelivery, deliverManualSlice, drainManualRuns } from '../../support/manual-run-delivery.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('manual continuation yields under foreground contention', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  afterEach(async () => { await f?.isolated.close(); });

  test.each(['account', 'collectionGate'] as const)('defers a busy %s without holding owner locks or losing work', async lock => {
    f = await automationRuntimeFixture('manual_contention_' + lock.toLowerCase(), true);
    for (let n = 1; n < 25; n++) await f.createNode('member-' + n, 'root', 'Paper', 'https://arxiv.org/' + n);
    const preview = await f.uow.execute(f.owner, p => p.runOnce!.preview(f.rule.id, {
      folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' },
      includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none',
    }));
    const run = await f.uow.execute(f.owner, p => p.runOnce!.start(f.rule.id, { previewId: preview.id, previewDigest: preview.previewDigest }));
    let release!: () => void, ready!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const foreground = f.db.transaction().execute(async tx => {
      if (lock === 'account') await tx.selectFrom('accounts').select('id').where('id', '=', f.owner.accountId).forUpdate().execute();
      else await lockCollectionReplicaGate(tx, 'collection');
      ready();
      await released;
    });
    await locked;
    const slice = deliverManualSlice(f.db);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const yielded = await Promise.race([slice.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
      expect(yielded).toBe(true);
      expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
      expect((await sql<{ attempt_count: number; state: string }>`SELECT attempt_count,state FROM outbox_events WHERE handler_name='automation_manual'`.execute(f.db)).rows)
        .toEqual([{ attempt_count: 0, state: 'pending' }]);
      // A collection blocked by another writer must not keep the account locked across deferral.
      if (lock === 'collectionGate') await f.db.transaction().execute(tx => tx.selectFrom('accounts').select('id')
        .where('id', '=', f.owner.accountId).forUpdate().noWait().execute());
      const stale = (await claimManualDelivery(f.db))!;
      await f.db.updateTable('outbox_events').set({ lease_generation: sql<bigint>`lease_generation+1` })
        .where('outbox_id', '=', stale.attempt!.outboxId).execute();
      await expect(createManualRunConsumer(f.db, 'server')(stale)).rejects.toThrow('lease lost');
      await f.db.updateTable('outbox_events').set({ state: 'pending', locked_until: null })
        .where('outbox_id', '=', stale.attempt!.outboxId).execute();
    } finally {
      clearTimeout(timer);
      release();
      await foreground;
      await slice;
    }
    await drainManualRuns(f.db);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(25);
    expect((await f.uow.execute(f.owner, p => p.runs.load(run.id)))!.view.status).toBe('completed');
  });
});
