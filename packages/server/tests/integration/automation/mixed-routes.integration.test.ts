import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationDeviceFixture } from '../../support/automation-device-fixture.js';
import { automationMixedWorker } from '../../support/automation-mixed-worker.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createRule, previewRule, setLifecycle } from '../../../src/modules/automation/index.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';

describeWithPostgres('automation and projection mixed durable queue', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  let consumers: ReturnType<typeof automationMixedWorker>[];
  beforeEach(async () => { f = await automationDeviceFixture('automation_mixed'); consumers = []; });
  afterEach(async () => {
    for (const consumer of consumers) await consumer.worker.stop();
    await f?.isolated.close();
  });
  async function round() {
    // Advance only the queue's availability clock. Claims, leases, deliveries and
    // completions all go through the real repositories and both durable routes.
    await f.db.updateTable('outbox_events').set({ available_at: new Date(0) })
      .where('state', 'in', ['pending', 'retryable']).execute();
    return Promise.all(consumers.map(consumer => consumer.worker.runOnce()));
  }
  async function drain() {
    for (let pass = 0; pass < 300; pass++) {
      await round();
      const remaining = await f.db.selectFrom('outbox_events').select('state').where('state', '!=', 'completed').execute();
      if (!remaining.length) return;
      expect(remaining.some(row => row.state === 'dead_lettered')).toBe(false);
    }
    throw new Error('Mixed durable queue did not converge within 300 bounded rounds');
  }

  test('two consumers converge with concurrent Sync, twelve matching rules, projection and replay', async () => {
    const configuration = createAutomationUnitOfWork(f.db, 'server', { runtimeEnabled: true });
    for (let index = 1; index < 12; index++) {
      await configuration.execute(f.owner, async ports => {
        const input = { definition: { ...f.rule.definition, name: `Compatible ${index}` }, bindingSetId: f.binding.id };
        const rule = await createRule(ports, f.owner, input);
        const preview = await previewRule(ports, f.owner, { rule: input, mode: 'currentState' });
        await setLifecycle(ports, f.owner, rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Mixed route regression',
          activationPreviewId: preview.previewId }, `"${rule.revision}"`);
      });
    }
    const slices: number[] = [];
    for (let index = 0; index < 2; index++) consumers.push(automationMixedWorker(f.db, f.isolated.runtime.pool,
      { onSlice: elapsedMs => slices.push(elapsedMs) }));
    await Promise.all([
      (async () => {
        for (let index = 0; index < 12; index++) await f.syncCreate(`sync-${index}`, `sync-operation-${index}`, 'root');
      })(),
      (async () => { for (let pass = 0; pass < 25; pass++) await round(); })(),
    ]);
    await drain();
    const synced = await f.db.selectFrom('nodes').select('parent_id').where('id', 'like', 'sync-%').execute();
    expect(synced).toHaveLength(12); expect(synced.every(row => row.parent_id === 'root')).toBe(true);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
    const canonical = createPostgresCanonicalMutationUnitOfWork(f.db, { automationOrigin: 'web' });
    for (let index = 0; index < 3; index++) {
      await canonical.execute(ports => createCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
        parentId: 'root', nodeId: `web-${index}`, afterId: null, beforeId: null, intakeDisposition: 'userDefault',
        node: { kind: 'bookmark', title: `Web ${index}`, url: 'https://arxiv.org/mixed', description: null, tags: [], visibility: 'inherit' } }));
    }
    await drain();
    const runs = (await sql<{ state: string }>`SELECT state FROM automation_runs`.execute(f.db)).rows;
    expect(runs).toHaveLength(36); expect(runs.every(run => run.state === 'completed')).toBe(true);
    const effects = (await sql<{ operation_id: string }>`SELECT operation_id FROM automation_effect_receipts`.execute(f.db)).rows;
    expect(effects).toHaveLength(36); expect(new Set(effects.map(effect => effect.operation_id)).size).toBe(3);
    for (let index = 0; index < 3; index++) {
      const projection = await consumers[0]!.projection.repository.getResource('collection', 'node', `web-${index}`);
      expect(projection?.lastEventType).toBe('node.moved');
    }
    await f.db.updateTable('outbox_events').set({ state: 'pending', completed_at: null, available_at: new Date(0) })
      .where('handler_name', '=', 'automation_ingest').where('state', '=', 'completed').execute();
    await drain();
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(36);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(36);
    expect(slices.length).toBeGreaterThan(0);
    expect(Math.max(...slices)).toBeLessThan(20000);
  }, 120000);
});
