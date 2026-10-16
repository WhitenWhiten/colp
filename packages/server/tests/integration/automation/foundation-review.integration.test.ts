import { afterEach, beforeEach, expect, test } from 'vitest';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationRuntime, createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createRule, saveBinding, previewRule, setLifecycle, setPause, revalidateRule, getAutomationRun } from '../../../src/modules/automation/index.js';

describeWithPostgres('BE-1/BE-2 foundation review', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  beforeEach(async () => { f = await automationRuntimeFixture('foundation_review', true); });
  afterEach(async () => { await f?.isolated.close(); });
  const execute = () => f.inspect(createAutomationRuntime('server'));
  const parent = async () => (await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'pending-paper').executeTakeFirstOrThrow()).parent_id;
  async function preview() {
    return f.uow.execute(f.owner, p => previewRule(p, f.owner, {
      rule: { definition: f.rule.definition, bindingSetId: f.binding.id }, mode: 'currentState',
    }));
  }
  test('reasserting an unpaused state preserves the admission fence and queued source', async () => {
    await f.createNode('pending-paper', 'root', 'Pending', 'https://arxiv.org/pending');
    const before = await f.db.selectFrom('automation_activations').selectAll().execute();
    await f.uow.execute(f.owner, p => setPause(p, f.owner, { paused: false }, '"0"'));
    expect(await f.db.selectFrom('automation_activations').selectAll().execute()).toEqual(before);
    await execute(); expect(await parent()).toBe('academic');
  });
  test('reasserting enabled with a fresh preview preserves the active admission interval', async () => {
    await f.createNode('pending-paper', 'root', 'Pending', 'https://arxiv.org/pending');
    const checked = await preview();
    await f.uow.execute(f.owner, async p => {
      const current = await p.rules.load(f.owner.accountId, f.rule.id);
      await setLifecycle(p, f.owner, f.rule.id, { state: 'enabled', pendingRuns: 'continuePinned',
        activationPreviewId: checked.previewId, reason: 'Keep enabled' }, `"${current!.view.revision}"`);
    });
    await execute(); expect(await parent()).toBe('academic');
  });
  test('editor configuration remains readable but cannot claim Owner runtime authority', async () => {
    const editor = await f.issue('editor');
    await f.db.insertInto('collection_members').values({ collection_id: 'collection', subject_id: editor.subjectId,
      role: 'editor', granted_at: new Date() }).execute();
    const configOnly = createAutomationUnitOfWork(f.db, 'server');
    const rule = await configOnly.execute(editor, async p => {
      const binding = await saveBinding(p, editor, { name: 'Editor folders', values: f.values });
      const input = { definition: f.rule.definition, bindingSetId: binding.id };
      const created = await createRule(p, editor, input);
      const checked = await previewRule(p, editor, { rule: input, mode: 'currentState' });
      return setLifecycle(p, editor, created.id, { state: 'enabled', pendingRuns: 'hold', activationPreviewId: checked.previewId, reason: 'Editor configuration' }, '"1"');
    });
    const report = await f.uow.execute(editor, p => revalidateRule(p, editor, rule.id));
    expect(report.effectiveState).toBe('blocked');
    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'permissionRevoked', blockingStages: ['intake'] })]));
    await f.uow.execute(editor, async p => {
      const checked = await previewRule(p, editor, { rule: { definition: rule.definition, bindingSetId: rule.bindingSetId }, mode: 'currentState' });
      await expect(setLifecycle(p, editor, rule.id, { state: 'enabled', pendingRuns: 'hold', activationPreviewId: checked.previewId, reason: 'Editor configuration' }, `"${rule.revision}"`))
        .rejects.toMatchObject({ code: 'insufficient_permission' });
    });
  });
  test('run read exposes the persisted placement reason and explicit hold', async () => {
    await f.createNode('pending-paper', 'root', 'Pending', 'https://arxiv.org/pending');
    await f.inspect();
    const row = await f.db.selectFrom('automation_runs').select('id').executeTakeFirstOrThrow();
    await f.uow.execute(f.owner, async p => {
      const rule = await p.rules.load(f.owner.accountId, f.rule.id);
      await p.pendingRuns(rule!.definitionRevisionId, 'hold');
    });
    const held = await f.uow.execute(f.owner, p => getAutomationRun(p.runs, row.id));
    expect(held).toMatchObject({ held: true, explanation: expect.stringMatching(/hold/i) });
    await f.uow.execute(f.owner, async p => {
      const rule = await p.rules.load(f.owner.accountId, f.rule.id);
      await p.pendingRuns(rule!.definitionRevisionId, 'continuePinned');
    });
    await execute();
    const completed = await f.uow.execute(f.owner, p => getAutomationRun(p.runs, row.id));
    expect(completed).toMatchObject({ held: false, explanation: expect.stringContaining('Matched the pinned rule') });
  });
  test('pause, preview and explicit continue release the same pinned run', async () => {
    await f.createNode('resume-paper', 'root', 'Pending', 'https://arxiv.org/resume');
    await f.inspect();
    const original = await f.db.selectFrom('automation_runs').select(['id', 'rule_revision_id', 'binding_revision', 'member_ids'])
      .executeTakeFirstOrThrow();
    const paused = await f.uow.execute(f.owner, async p => {
      const current = (await p.rules.load(f.owner.accountId, f.rule.id))!.view;
      return setLifecycle(p, f.owner, current.id, { state: 'paused', pendingRuns: 'hold', reason: 'Owner paused.' }, `"${current.revision}"`);
    });
    expect(await f.uow.execute(f.owner, p => getAutomationRun(p.runs, original.id))).toMatchObject({ held: true });
    expect((await f.uow.execute(f.owner, p => p.usage!.rule(paused.id))).heldRuns).toBe(1);
    const checked = await f.uow.execute(f.owner, p => previewRule(p, f.owner, {
      rule: { definition: paused.definition, bindingSetId: paused.bindingSetId }, ruleId: paused.id, mode: 'currentState',
    }));
    await f.uow.execute(f.owner, p => setLifecycle(p, f.owner, paused.id, {
      state: 'enabled', pendingRuns: 'continuePinned', activationPreviewId: checked.previewId, reason: 'Owner continued earlier work.',
    }, `"${paused.revision}"`));
    expect(await f.uow.execute(f.owner, p => getAutomationRun(p.runs, original.id))).toMatchObject({ held: false });
    expect((await f.uow.execute(f.owner, p => p.usage!.rule(paused.id))).heldRuns).toBe(0);
    expect(await f.db.selectFrom('automation_runs').select(['rule_revision_id', 'binding_revision', 'member_ids'])
      .where('id', '=', original.id).executeTakeFirstOrThrow()).toEqual({
      rule_revision_id: original.rule_revision_id, binding_revision: original.binding_revision, member_ids: original.member_ids,
    });
  });
});
