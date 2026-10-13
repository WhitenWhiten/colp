import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { updateCollectionNode, moveCollectionNode } from '../../../src/modules/collections/index.js';
import { setAutomationCaptureEnabled } from '../../../src/infrastructure/automation/index.js';
import { retainAutomationHistory } from '../../../src/infrastructure/automation/retention-worker.js';
import { inspectAutomationOutbox } from '../../support/automation-runtime-fixture.js';

describeWithPostgres('automation event-time facts', () => {
  let f: Awaited<ReturnType<typeof automationFixture>>;
  beforeAll(async () => { f = await automationFixture('aw13'); });
  afterAll(async () => { await f?.isolated.close(); });
  test('captures immutable before/after facts, and rollback removes facts with the canonical write', async () => {
    const original = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'paper').executeTakeFirstOrThrow();
    await f.canonical.execute(ports => updateCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'paper', ifMatch: `"${original.resource_revision}"`, patch: { url: 'https://example.test/changed' } }));
    const updated = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'paper').executeTakeFirstOrThrow();
    const parents = await f.db.selectFrom('nodes').select(['id', 'children_revision']).where('id', 'in', ['root', 'academic']).execute();
    await f.canonical.execute(ports => moveCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'paper', ifMatch: `"${updated.resource_revision}"`, newParentId: 'academic', baseSourceParentRevision: parents.find(p => p.id === 'root')!.children_revision, baseTargetParentRevision: parents.find(p => p.id === 'academic')!.children_revision, afterId: null, beforeId: null }));
    const rows = (await sql<{ facts_json: { before: { url: string; parentId: string }; after: { url: string; parentId: string; ancestorIds: string[] } }; origin: string }>`
      SELECT facts_json, origin FROM automation_event_facts WHERE node_id='paper' ORDER BY commit_ordinal`.execute(f.db)).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.facts_json.after.url).toBe('https://arxiv.org/abs/fixture');
    expect(rows[1]!.facts_json.before.url).toBe('https://arxiv.org/abs/fixture');
    expect(rows[1]!.facts_json.after.parentId).toBe('root');
    expect(rows[2]!.facts_json.after.ancestorIds).toEqual(['academic', 'parent', 'root']);
    expect(rows.every(row => row.origin === 'web')).toBe(true);
    const moved = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'paper').executeTakeFirstOrThrow();
    const failing = createPostgresCanonicalMutationUnitOfWork(f.db, { canonicalFaultInjector: { afterPhase({ phase }) {
      if (phase === 'facts') throw new Error('fault after private facts');
    } } });
    await expect(failing.execute(ports => updateCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'paper', ifMatch: `"${moved.resource_revision}"`, patch: { title: 'rolled back' } }))).rejects.toThrow('fault after private facts');
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_event_facts WHERE node_id='paper'`.execute(f.db)).rows[0]!.count).toBe('3');
    expect((await f.db.selectFrom('nodes').select('title').where('id', '=', 'paper').executeTakeFirstOrThrow()).title).toBe('Paper');
  });

  test('capture writes exactly one private fact and one automation wake per canonical node operation', async () => {
    const before = (await sql<{ facts: string; wakes: string }>`SELECT (SELECT count(*) FROM automation_event_facts) AS facts,
      (SELECT count(*) FROM outbox_events WHERE handler_name='automation_ingest') AS wakes`.execute(f.db)).rows[0]!;
    await f.createNode('captured', 'root', 'Captured', 'https://arxiv.org/abs/captured');
    const after = (await sql<{ facts: string; wakes: string }>`SELECT (SELECT count(*) FROM automation_event_facts) AS facts,
      (SELECT count(*) FROM outbox_events WHERE handler_name='automation_ingest') AS wakes`.execute(f.db)).rows[0]!;
    expect([Number(after.facts) - Number(before.facts), Number(after.wakes) - Number(before.wakes)]).toEqual([1, 1]);
  });
  test('with KNOWN_FEATURE_AUTOMATION_CAPTURE off a mutation writes no facts, no wake and no ledger reservation', async () => {
    const counts = async () => (await sql<{ facts: string; wakes: string; ledger: string }>`SELECT
      (SELECT count(*) FROM automation_event_facts) AS facts,
      (SELECT count(*) FROM outbox_events WHERE handler_name='automation_ingest') AS wakes,
      (SELECT count(*) FROM resource_id_ledger WHERE resource_type='outbox') AS ledger`.execute(f.db)).rows[0]!;
    const outboxBefore = await counts();
    setAutomationCaptureEnabled(false);
    try {
      await f.createNode('uncaptured', 'root', 'Uncaptured', 'https://arxiv.org/abs/uncaptured');
      const node = await f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'uncaptured').executeTakeFirstOrThrow();
      await f.canonical.execute(ports => updateCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
        nodeId: 'uncaptured', ifMatch: `"${node.resource_revision}"`, patch: { title: 'Still uncaptured' } }));
      const after = await counts();
      expect(after.facts).toBe(outboxBefore.facts);
      expect(after.wakes).toBe(outboxBefore.wakes);
      // Only the canonical domain events reserve Outbox identities.
      expect(Number(after.ledger) - Number(outboxBefore.ledger)).toBe(2);
    } finally { setAutomationCaptureEnabled(true); }
  });
  test('shadow capture advances the source cursor without admitting anything', async () => {
    await f.createNode('shadow', 'root', 'Shadow', 'https://arxiv.org/abs/shadow');
    await inspectAutomationOutbox(f.db, null);
    const position = (await sql<{ last_inspected_ordinal: string }>`SELECT last_inspected_ordinal::text FROM automation_source_positions
      WHERE collection_id='collection'`.execute(f.db)).rows[0]!;
    const head = (await sql<{ ordinal: string }>`SELECT max(commit_ordinal)::text AS ordinal FROM operations WHERE collection_id='collection'`.execute(f.db)).rows[0]!;
    expect(position.last_inspected_ordinal).toBe(head.ordinal);
    expect((await sql`SELECT 1 FROM automation_runs`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT 1 FROM automation_admission_receipts`.execute(f.db)).rows).toEqual([]);
  });
  test('retention deletes inspected, unreferenced facts after the window and keeps referenced ones', async () => {
    await sql`UPDATE automation_event_facts SET occurred_at=clock_timestamp()-interval '31 days'`.execute(f.db);
    const kept = (await sql<{ operation_id: string }>`SELECT operation_id FROM automation_event_facts WHERE node_id='shadow'`.execute(f.db)).rows[0]!;
    await sql`INSERT INTO automation_intake_receipts(id,owner_id,device_id,replica_generation,local_receipt_id,operation_id,state,receipt_json)
      VALUES('retained',${f.owner.accountId},'device',1,'local',${kept.operation_id},'accepted','{}'::jsonb)`.execute(f.db);
    await retainAutomationHistory(f.db, f.owner.accountId, false);
    const rows = (await sql<{ node_id: string }>`SELECT node_id FROM automation_event_facts`.execute(f.db)).rows;
    expect(rows).toEqual([{ node_id: 'shadow' }]);
  });
});
