import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { validateAutomation } from '@know-n/colp/automation';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createAutomationRuntime } from '../../../src/infrastructure/automation/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';
import { previewRule, validateRule } from '../../../src/modules/automation/index.js';

describeWithPostgres('M1 hardening contracts and upgrade', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  beforeEach(async () => { f = await automationRuntimeFixture('hardening_contract', true); });
  afterEach(async () => { await f?.isolated.close(); });

  test('policy diagnostics and current-state counts remain side-effect-free closed DTOs', async () => {
    const rule = { definition: { ...f.rule.definition, policy: { ...f.rule.definition.policy, maxRunsPerDay: 1, missingInput: 'defer' } },
      bindingSetId: f.binding.id };
    const validation = await f.uow.execute(f.owner, ports => validateRule(ports, f.owner, rule));
    expect(validateAutomation('ValidationResult', validation).valid).toBe(true);
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['dailyAdmissionLimit', 'immutableInputDeferred']));
    const preview = await f.uow.execute(f.owner, ports => previewRule(ports, f.owner, { rule, mode: 'currentState' }));
    expect(validateAutomation('PreviewResult', preview).valid).toBe(true);
    expect(preview).toMatchObject({ sideEffects: false, plannedRunCount: 0 });
    expect(preview.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['previewDecisionCounts', 'dailyAdmissionLimit', 'immutableInputDeferred']));
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
  });

  test('capacity upgrade backfills real completed history once without changing effects or pins', async () => {
    const canonical = createPostgresCanonicalMutationUnitOfWork(f.db, { automationOrigin: 'web' });
    await canonical.execute(ports => createCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      parentId: 'root', nodeId: 'upgrade-paper', afterId: null, beforeId: null, intakeDisposition: 'userDefault',
      node: { kind: 'bookmark', title: 'Upgrade paper', url: 'https://arxiv.org/upgrade', description: null, tags: [], visibility: 'inherit' } }));
    await f.inspect(createAutomationRuntime('server'));
    const before = (await sql`SELECT id,rule_revision_id,binding_revision,member_ids FROM automation_runs`.execute(f.db)).rows;
    const effects = (await sql`SELECT id,operation_id,effect_digest FROM automation_effect_receipts`.execute(f.db)).rows;
    expect(before).toHaveLength(1); expect(effects).toHaveLength(1);
    const migrator = createMigrator(f.db, 'migrations', f.isolated.schema);
    // Test-only downgrade removes only the newly added capacity tables, leaving
    // a genuine pre-capacity installation's immutable completed history.
    const older = await migrator.migrateTo('202610301000_automation_receipt_waiting_index');
    if (older.error) throw older.error;
    await runMigrations(f.db, 'latest');
    const reservations = (await sql<{ valid: boolean }>`SELECT q.run_id=r.id AND q.rule_id=v.rule_id
      AND q.admission_day=(r.created_at AT TIME ZONE 'UTC')::date AS valid
      FROM automation_intake_reservations q JOIN automation_runs r ON r.id=q.run_id
      JOIN automation_rule_revisions v ON v.id=r.rule_revision_id`.execute(f.db)).rows;
    expect(reservations).toEqual([{ valid: true }]);
    await runMigrations(f.db, 'latest'); await f.inspect(createAutomationRuntime('server'));
    expect((await sql`SELECT id,rule_revision_id,binding_revision,member_ids FROM automation_runs`.execute(f.db)).rows).toEqual(before);
    expect((await sql`SELECT id,operation_id,effect_digest FROM automation_effect_receipts`.execute(f.db)).rows).toEqual(effects);
    expect((await sql`SELECT run_id FROM automation_intake_reservations`.execute(f.db)).rows).toHaveLength(1);
  });
});
