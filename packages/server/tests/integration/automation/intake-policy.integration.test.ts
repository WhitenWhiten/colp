import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import type { RuleDefinition } from '@know-n/colp/automation';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationRuntime } from '../../../src/infrastructure/automation/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';
import { replaceRule, previewRule, setLifecycle, getAutomationRun, cancelAutomationRun } from '../../../src/modules/automation/index.js';

describeWithPostgres('M1 pinned input and daily admission policies', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  beforeEach(async () => { f = await automationRuntimeFixture('intake_policy', true); });
  afterEach(async () => { await f?.isolated.close(); });
  const execute = () => f.inspect(createAutomationRuntime('server'));
  const parent = async (nodeId: string) => (await f.db.selectFrom('nodes').select('parent_id').where('id', '=', nodeId).executeTakeFirstOrThrow()).parent_id;
  async function configure(policy: Partial<RuleDefinition['policy']>) {
    return f.uow.execute(f.owner, async ports => {
      const stored = (await ports.rules.load(f.owner.accountId, f.rule.id))!;
      const definition = { ...stored.view.definition, policy: { ...stored.view.definition.policy, ...policy } };
      const updated = await replaceRule(ports, f.owner, f.rule.id, { definition, bindingSetId: stored.view.bindingSetId,
        pendingRuns: 'continuePinned', counterPolicy: 'resetOnSemanticChange' }, `"${stored.view.revision}"`);
      const preview = await previewRule(ports, f.owner, { mode: 'currentState', rule: { definition, bindingSetId: updated.bindingSetId } });
      return setLifecycle(ports, f.owner, f.rule.id, { state: 'enabled', pendingRuns: 'continuePinned', reason: 'Policy regression',
        activationPreviewId: preview.previewId }, `"${updated.revision}"`);
    });
  }
  async function create(nodeId: string, url = 'https://arxiv.org/policy') {
    const uow = createPostgresCanonicalMutationUnitOfWork(f.db, { automationOrigin: 'web' });
    return uow.execute(ports => createCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      parentId: 'root', nodeId, intakeDisposition: 'userDefault', afterId: null, beforeId: null,
      node: { kind: 'bookmark', title: nodeId, url, description: null, tags: [], visibility: 'inherit' } }));
  }
  async function run(nodeId: string) {
    const row = (await sql<{ id: string }>`SELECT id FROM automation_runs WHERE explanation_json->>'nodeId'=${nodeId}`.execute(f.db)).rows[0]!;
    return f.uow.execute(f.owner, ports => getAutomationRun(ports.runs, row.id));
  }
  async function advanceCapacityWindow() {
    // Simulate UTC rollover only in private scheduling/accounting rows. Never
    // alter canonical facts, source positions, rule/binding pins or revisions.
    await sql`UPDATE automation_intake_reservations SET admission_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1`.execute(f.db);
    await sql`UPDATE automation_intake_delays SET available_at=clock_timestamp()-interval '1 second'`.execute(f.db);
    await sql`UPDATE automation_intake_wakes SET available_at=clock_timestamp()-interval '1 second'`.execute(f.db);
  }

  test('daily limit retains overflow once and schedules a shared UTC wake without early execution', async () => {
    await configure({ maxRunsPerDay: 1 });
    await create('first'); await create('second'); await create('third');
    const runtime = createAutomationRuntime('server');
    await f.inspect(async (tx, actor, collectionId, sources) => {
      await sql`SET LOCAL TIME ZONE 'Pacific/Auckland'`.execute(tx);
      return runtime(tx, actor, collectionId, sources);
    });
    expect(await parent('first')).toBe('academic');
    expect(await parent('second')).toBe('root'); expect(await parent('third')).toBe('root');
    expect(await run('second')).toMatchObject({ status: 'waiting', held: false, explanation: expect.stringContaining('Daily run limit') });
    const wakes = (await sql<{ available_at: Date }>`SELECT available_at FROM automation_intake_wakes`.execute(f.db)).rows;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.available_at.getUTCHours()).toBe(0); expect(wakes[0]!.available_at.getUTCMinutes()).toBe(0);
    expect(await f.db.selectFrom('outbox_events').select('available_at').where('event_type', '=', 'automation.intake.resume')
      .where('available_at', '=', wakes[0]!.available_at).execute()).toHaveLength(1);
    await execute(); await execute();
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(1);
    await advanceCapacityWindow(); await execute();
    expect(await parent('second')).toBe('academic'); expect(await parent('third')).toBe('root');
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(3);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(2);
  });

  test('editing a logical rule cannot reset its daily count or rebind earlier waiting work', async () => {
    await configure({ maxRunsPerDay: 1 }); await create('before-edit'); await execute();
    const before = await run('before-edit');
    await configure({ maxRunsPerDay: 1 }); await create('after-edit'); await execute();
    const after = await run('after-edit');
    expect(after.ruleRevision).not.toBe(before.ruleRevision);
    expect(after.status).toBe('waiting'); expect(await parent('after-edit')).toBe('root');
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toHaveLength(1);
  });

  test('explicit holds and cancellation remain authoritative after capacity becomes available', async () => {
    await configure({ maxRunsPerDay: 1 });
    await create('allowed'); await create('held'); await create('cancelled'); await execute();
    const cancelled = await run('cancelled');
    await f.uow.execute(f.owner, ports => cancelAutomationRun(ports.runs, cancelled.id, `"${cancelled.revision}"`));
    await f.uow.execute(f.owner, async ports => {
      const current = (await ports.rules.load(f.owner.accountId, f.rule.id))!;
      await ports.pendingRuns(current.definitionRevisionId, 'hold');
    });
    const held = await run('held');
    await advanceCapacityWindow(); await execute();
    expect(await parent('held')).toBe('root'); expect(await parent('cancelled')).toBe('root');
    await f.uow.execute(f.owner, async ports => {
      const current = (await ports.rules.load(f.owner.accountId, f.rule.id))!;
      await ports.pendingRuns(current.definitionRevisionId, 'continuePinned');
    });
    await execute();
    expect(await parent('held')).toBe('academic'); expect(await parent('cancelled')).toBe('root');
    expect(await run('held')).toMatchObject({ ruleRevision: held.ruleRevision, bindingRevision: held.bindingRevision, status: 'completed' });
    expect((await run('cancelled')).status).toBe('cancelled');
  });

  test('pre-commit failure rolls back quota reservations together with effects, runs and source progress', async () => {
    await configure({ maxRunsPerDay: 1 }); await create('rollback');
    const runtime = createAutomationRuntime('server');
    await expect(f.inspect(async (tx, actor, collectionId, sources) => {
      await runtime(tx, actor, collectionId, sources);
      throw new Error('fault after quota and effect');
    })).rejects.toThrow('fault after quota and effect');
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
    expect(await parent('rollback')).toBe('root');
    await execute(); await execute();
    expect(await parent('rollback')).toBe('academic');
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toHaveLength(1);
  });

  test.each(['defer', 'review'] as const)('missingInput=%s retains the immutable source without inventing a placement', async missingInput => {
    await configure({ missingInput });
    // A real canonical URL under 4096 bytes but beyond the finite path limit.
    await create('missing', `https://arxiv.org/${'x'.repeat(2050)}`);
    await execute();
    const original = await run('missing');
    expect(original).toMatchObject({ status: missingInput === 'defer' ? 'waiting' : 'review', effects: [], held: false });
    expect(original.explanation).toMatch(/immutable source/);
    await f.uow.execute(f.owner, async ports => {
      const current = (await ports.rules.load(f.owner.accountId, f.rule.id))!;
      await ports.pendingRuns(current.definitionRevisionId, 'continuePinned');
    });
    await execute();
    expect(await parent('missing')).toBe('root');
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(1);
    expect((await run('missing')).ruleRevision).toBe(original.ruleRevision);
    const latest = await run('missing');
    expect(await f.uow.execute(f.owner, ports => cancelAutomationRun(ports.runs, latest.id, `"${latest.revision}"`)))
      .toMatchObject({ status: 'cancelled', effects: [] });
  });
});
