import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { updateCollectionNode, moveCollectionNode } from '../../../src/modules/collections/index.js';

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
});
