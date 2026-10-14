import { beforeAll, afterAll, test, expect } from 'vitest';
import { createBindingReadPort, createBindingStore } from '../../../src/infrastructure/automation/bindings.js';
import { createDependencyIndex } from '../../../src/infrastructure/automation/dependency-index.js';
import { resolveBindings } from '../../../src/modules/automation/application/resolve-bindings.js';
import { automationDigest } from '@know-n/colp/automation';
import { automationFixture } from '../../support/automation-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('canonical folder bindings and reverse dependencies', () => {
  let fixture: Awaited<ReturnType<typeof automationFixture>>;
  beforeAll(async () => {
    fixture = await automationFixture('automation_bindings');
    const { db, owner, values } = fixture;
    await db.transaction().execute(async (tx) => createBindingStore(tx).save(owner.accountId, {
      id: 'bindings', revision: '1', name: 'Academic', values, updatedAt: new Date().toISOString(),
    }));
    await fixture.createNode('replacement', 'parent', 'Academic');
  }, 180_000);
  afterAll(async () => fixture?.isolated.close());
  test('rename preserves identity and binding semantic revision; same-name folder never rebinds', async () => {
    const { db, owner, rule, values, folder } = fixture;
    const reads = createBindingReadPort(db, 'server');
    const initial = await resolveBindings(reads, owner, rule, values);
    expect(initial.academicRoot?.status).toBe('valid');
    await fixture.rename('academic', 'Renamed');
    const renamed = await reads.readFolder(owner, folder);
    expect(renamed).toMatchObject({ status: 'valid', snapshot: { title: 'Renamed', folder } });
    expect((await createBindingStore(db).load(owner.accountId, 'bindings'))?.revision).toBe('1');
    await db.updateTable('nodes').set({ deleted_at: new Date() }).where('id', '=', 'academic').execute();
    expect(await reads.readFolder(owner, folder)).toMatchObject({ status: 'blocked', code: 'bindingDeleted' });
    await db.updateTable('nodes').set({ deleted_at: null }).where('id', '=', 'academic').execute();
    expect((await reads.readFolder(owner, folder)).status).toBe('valid');
    const foreign = await fixture.issue('foreign');
    expect(await reads.readFolder(foreign, folder)).toMatchObject({ status: 'blocked', code: 'permissionRevoked' });
    expect(await reads.readFolder(owner, { ...folder, serverUuid: 'other' })).toMatchObject({ status: 'blocked', code: 'scopeChanged' });
  });
  test('ancestor constraints and a single reverse query find every dependent stage', async () => {
    const { db, owner, rule, values, folder } = fixture;
    const reads = createBindingReadPort(db, 'server');
    const resolved = await resolveBindings(reads, owner, rule, values);
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('automation_rules').values({ id: 'rule', owner_id: owner.accountId, current_revision_id: null, desired_state: 'draft' }).execute();
      await tx.insertInto('automation_rule_revisions').values({ id: 'revision', rule_id: 'rule', owner_id: owner.accountId, revision: '1', definition_json: rule,
        binding_set_id: 'bindings', execution_policy_id: null, template_ref: null, semantic_digest: automationDigest(rule) }).execute();
      await tx.updateTable('automation_rules').set({ current_revision_id: 'revision' }).where('id', '=', 'rule').execute();
      await createDependencyIndex(tx).replace('revision', resolved);
    });
    expect(await createDependencyIndex(db).affected(['parent'])).toEqual([{ ownerId: owner.accountId, ruleId: 'rule' }]);
    const invalid = { academicRoot: { ...values.academicRoot, allowedAncestor: { ...folder, nodeId: 'replacement' } } };
    expect((await resolveBindings(reads, owner, rule, invalid)).academicRoot).toMatchObject({ status: 'blocked', code: 'scopeChanged' });
    expect(await createBindingStore(db).load('foreign', 'bindings')).toBeNull();
  });
});
