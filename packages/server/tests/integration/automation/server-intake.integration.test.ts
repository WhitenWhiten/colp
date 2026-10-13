import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationRuntime } from '../../../src/infrastructure/automation/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createCollectionNode, moveCollectionNode } from '../../../src/modules/collections/index.js';
import { getAutomationRun, setPause } from '../../../src/modules/automation/index.js';
describeWithPostgres('server M1 intake', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  beforeEach(async () => { f = await automationRuntimeFixture('aw33', true); });
  afterEach(async () => { await f?.isolated.close(); });
  const execute = () => f.inspect(createAutomationRuntime('server'));
  const parent = async (id: string) => (await f.db.selectFrom('nodes').select('parent_id').where('id', '=', id).executeTakeFirstOrThrow()).parent_id;
  async function create(id: string, origin: 'web' | 'mcp' | 'import', parentId = 'root') {
    const uow = createPostgresCanonicalMutationUnitOfWork(f.db, { automationOrigin: origin });
    return uow.execute(p => createCollectionNode(p, { actor: f.actor, command: f.command(), collectionId: 'collection', parentId,
      nodeId: id, intakeDisposition: 'userDefault', afterId: null, beforeId: null, node: { kind: 'bookmark', title: id, url: 'https://arxiv.org/fixture',
        description: null, tags: [], visibility: 'inherit' } }));
  }
  test('web and MCP default-root creates move once, explicit folders/imports and projection retries do not intake', async () => {
    await create('web-paper', 'web'); await create('mcp-paper', 'mcp'); await create('selected-paper', 'web', 'parent'); await create('imported-paper', 'import');
    await execute(); await execute();
    expect(await parent('web-paper')).toBe('academic'); expect(await parent('mcp-paper')).toBe('academic');
    expect(await parent('selected-paper')).toBe('parent'); expect(await parent('imported-paper')).toBe('root');
    const effects = (await sql<{ operation_id: string }>`SELECT operation_id FROM automation_effect_receipts`.execute(f.db)).rows;
    expect(effects).toHaveLength(2); expect(new Set(effects.map(row => row.operation_id)).size).toBe(2);
    const versions = await f.db.selectFrom('collection_tree_versions').select('cause').execute();
    expect(versions.map(row => row.cause)).toEqual([`automation:${f.rule.id}`, `automation:${f.rule.id}`]);
    const facts = (await sql<{ origin: string; facts_json: { stageId: string } }>`SELECT origin,facts_json FROM automation_event_facts
      WHERE operation_id=ANY(${effects.map(row => row.operation_id)}::text[])`.execute(f.db)).rows;
    expect(facts.every(row => row.origin === 'automation' && row.facts_json.stageId === 'intake')).toBe(true);
    expect((await sql<{ count: string }>`SELECT count(*) FROM automation_jobs`.execute(f.db)).rows[0]!.count).toBe('0');
  });
  test('manual movement after admission blocks the stale effect', async () => {
    await create('manual-paper', 'web'); await f.inspect(); // admit only, before effect executor
    const node = await f.db.selectFrom('nodes').selectAll().where('id', '=', 'manual-paper').executeTakeFirstOrThrow();
    const source = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', 'root').executeTakeFirstOrThrow();
    const target = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', 'parent').executeTakeFirstOrThrow();
    await f.canonical.execute(p => moveCollectionNode(p, { actor: f.actor, command: f.command(), collectionId: 'collection', nodeId: 'manual-paper',
      ifMatch: node.resource_revision, newParentId: 'parent', afterId: null, beforeId: null,
      baseSourceParentRevision: source.children_revision, baseTargetParentRevision: target.children_revision }));
    await execute(); expect(await parent('manual-paper')).toBe('parent');
    expect((await sql<{ state: string }>`SELECT state FROM automation_runs`.execute(f.db)).rows).toEqual([{ state: 'review' }]);
  });
  test('resume creates a durable wake for held pinned work without replaying the paused interval', async () => {
    await create('held-paper', 'web'); await f.inspect();
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: true, reason: 'Pause' }, '"0"'));
    await create('skip-paper', 'web'); await execute(); expect(await parent('held-paper')).toBe('root');
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: false, reason: 'Resume' }, '"1"'));
    expect(await f.db.selectFrom('outbox_events').select('outbox_id').where('event_type', '=', 'automation.intake.resume').execute()).toHaveLength(1);
    await execute(); expect(await parent('held-paper')).toBe('academic'); expect(await parent('skip-paper')).toBe('root');
    const row = (await sql<{ id: string }>`SELECT id FROM automation_runs`.execute(f.db)).rows[0]!;
    const run = await f.uow.execute(f.owner, p => getAutomationRun(p.runs, row.id));
    expect(run.effects[0]!.undoAvailable).toBe(true);
  });
});
