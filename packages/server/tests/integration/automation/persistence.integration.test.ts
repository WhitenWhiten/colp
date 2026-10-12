import { beforeAll, afterAll, test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { automationDigest, validateAutomation } from '@know-n/colp/automation';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createOwnedCollectionCanonical } from '../../../src/modules/collections/index.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { exportAutomations } from '../../../src/infrastructure/automation/export.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const definition = JSON.parse(readFileSync('../node/tests/fixtures/automation/m1-placement.json', 'utf8'));
describeWithPostgres('BE-1 migrations, immutable persistence and recovery', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('automation_persistence');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const baseline = await migrator.migrateTo('202610290100_link_preview_object_bytes');
    if (baseline.error) throw baseline.error;
    expect((await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(isolated.runtime.db)).rows[0]?.name)
      .toBe('202610290100_link_preview_object_bytes');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());
  test('fresh install also reaches the same migration head', async () => {
    const fresh = await createIsolatedPostgresRuntime('automation_fresh');
    try {
      await runMigrations(fresh.runtime.db, 'latest');
      expect((await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(fresh.runtime.db)).rows[0]?.name)
        .toBe('202610300200_automation_runtime');
    } finally { await fresh.close(); }
  }, 180_000);
  test('configuration has immutable revisions, owner FKs and atomic deferred-current links', async () => {
    const db = isolated.runtime.db;
    await db.insertInto('accounts').values({ id: 'owner', subject_id: 'owner', status: 'active', created_at: new Date(), deleted_at: null }).execute();
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('automation_binding_sets').values({ id: 'bindings', owner_id: 'owner', rule_id: null, current_revision: '1', name: 'Folders' }).execute();
      await tx.insertInto('automation_binding_revisions').values({ binding_set_id: 'bindings', revision: '1', values_json: {}, semantic_digest: automationDigest({}) }).execute();
      await tx.insertInto('automation_rules').values({ id: 'rule', owner_id: 'owner', current_revision_id: null, desired_state: 'draft' }).execute();
      await tx.insertInto('automation_rule_revisions').values({ id: 'revision', rule_id: 'rule', owner_id: 'owner', revision: '1', definition_json: definition,
        binding_set_id: 'bindings', execution_policy_id: null, template_ref: null, semantic_digest: automationDigest(definition) }).execute();
      await tx.updateTable('automation_rules').set({ current_revision_id: 'revision' }).where('id', '=', 'rule').execute();
    });
    await expect(db.updateTable('automation_rule_revisions').set({ revision: '2' }).where('id', '=', 'revision').execute()).rejects.toThrow('immutable');
    await expect(db.insertInto('automation_binding_revisions').values({ binding_set_id: 'bindings', revision: '1', values_json: {}, semantic_digest: automationDigest({}) }).execute()).rejects.toThrow();
    await expect(db.transaction().execute(async (tx) => {
      await tx.insertInto('automation_binding_sets').values({ id: 'bad', owner_id: 'owner', rule_id: null, current_revision: '1', name: 'Bad' }).execute();
    })).rejects.toThrow();
    expect(await db.selectFrom('automation_binding_sets').select('id').where('id', '=', 'bad').executeTakeFirst()).toBeUndefined();
    await expect(db.insertInto('automation_rule_revisions').values({ id: randomUUID(), rule_id: 'rule', owner_id: 'foreign', revision: '2', definition_json: definition,
      binding_set_id: 'bindings', execution_policy_id: null, template_ref: null, semantic_digest: automationDigest(definition) }).execute()).rejects.toThrow();
    const exported = await exportAutomations(db, 'owner');
    expect(validateAutomation('AutomationExport', exported).valid).toBe(true);
    const encoded = JSON.stringify(exported);
    expect(encoded).not.toContain('collectionId'); expect(encoded).not.toContain('bindingSetId'); expect(encoded).not.toContain('targetIds');
    expect(exported.rules[0]?.desiredState).toBe('draft');
  });
  test('duplicate M1 admission and nullable-target effects have one database winner', async () => {
    const db = isolated.runtime.db;
    const created = await createPostgresCanonicalMutationUnitOfWork(db).execute((ports) => createOwnedCollectionCanonical(ports, {
      actor: { principalId: 'owner', subjectId: 'owner', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: 'fixture' }, title: 'Automation fixture', summary: null, kind: 'bookmarks',
      collectionId: 'fixture_collection', rootNodeId: 'fixture_root', operationId: 'fixture_operation',
    }));
    expect(created.kind).toBe('created');
    await sql`insert into automation_event_facts values ('event','fixture_operation','fixture_collection','fixture_root',1,now(),'user','{}',1,null)`.execute(db);
    await sql`insert into automation_runs (id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state)
      values ('run','owner','intake','revision','bindings',1,null,'[]','waiting')`.execute(db);
    const admission = () => sql`insert into automation_admission_receipts values ('revision','event','intake','matched','run')`.execute(db);
    await admission(); await expect(admission()).rejects.toThrow();
    const effect = (id: string) => sql`insert into automation_effect_receipts (id,run_id,step_id,operation_id,after_revision,effect_digest)
      values (${id},'run','intake','fixture_operation','after','digest')`.execute(db);
    await effect('effect'); await expect(effect('duplicate')).rejects.toThrow();
  });
  test('schema backup/restore preserves rules and runs the deployment pause SQL before restart', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'colp-automation-backup-'));
    try {
      const dump = join(scratch, 'backup.dump');
      const backupUrl = new URL(isolated.databaseUrl); backupUrl.searchParams.delete('options');
      execFileSync('pg_dump', ['--dbname', backupUrl.toString(), '--schema', isolated.schema, '--format=custom', '--file', dump]);
      execFileSync('pg_restore', ['--dbname', backupUrl.toString(), '--schema', isolated.schema, '--clean', '--if-exists', '--exit-on-error', '--single-transaction', dump]);
      const restore = readFileSync('../../deploy/restore.sh', 'utf8');
      const pauseSql = restore.split("<<'SQL'\n")[1]?.split('\nSQL')[0];
      expect(pauseSql).toBeTruthy();
      await sql.raw(pauseSql!).execute(isolated.runtime.db);
      const state = await isolated.runtime.db.selectFrom('automation_settings').selectAll().where('owner_id', '=', 'owner').executeTakeFirstOrThrow();
      expect(state.paused).toBe(true); expect(state.paused_by).toBe('restore');
      expect((await exportAutomations(isolated.runtime.db, 'owner')).rules).toHaveLength(1);
      // Opening another connection simulates process recreation without resetting configuration.
      const restored = await isolated.runtime.pool.query('select desired_state from automation_rules where id=$1', ['rule']);
      expect(restored.rows[0].desired_state).toBe('draft');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
