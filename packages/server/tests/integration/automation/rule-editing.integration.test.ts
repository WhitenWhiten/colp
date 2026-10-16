import { afterEach,expect,test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createRule,previewRule,replaceRule,setLifecycle,saveBinding } from '../../../src/modules/automation/index.js';
import { ruleInput as editorInput,draftFromRule,draftDefinition } from '../../../../web/src/pages/automations/ruleDraft.js';

describeWithPostgres('editor configuration and activation contract', () => {
  let runtime: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  let worker: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await runtime?.isolated.close(); await worker?.close(); });
  test.each(['name','match','folder'] as const)('editing enabled M1 %s previews, saves and enables once', async field => {
    runtime = await automationRuntimeFixture('edit_'+field,true);
    const f = runtime;
    const stored = await f.uow.execute(f.owner, async p => (await p.rules.load(f.owner.accountId,f.rule.id))!.view);
    const draft = draftFromRule(stored,f.binding)!;
    expect(draft).not.toBeNull();
    if (field === 'name') draft.name='Renamed';
    if (field === 'match') draft.conditions[0]!.value='example.org';
    const binding = field === 'folder' ? await f.uow.execute(f.owner,p => saveBinding(p,f.owner,{ name:'Other',values:{ academicRoot:{ ...f.values.academicRoot,folder:{ ...f.folder,nodeId:'parent' } } } })) : f.binding;
    if (field === 'folder') draft.folderId='parent';
    const input = editorInput(draftDefinition(draft,'unused',stored.definition),binding.id,stored);
    const preview = await f.uow.execute(f.owner,p => previewRule(p,f.owner,{ rule:input,ruleId:stored.id,mode:'currentState' }));
    const { templateRef:_template,...change } = input;
    const saved = await f.uow.execute(f.owner,p => replaceRule(p,f.owner,stored.id,{ ...change,pendingRuns:'hold',counterPolicy:'resetOnSemanticChange' },`"${stored.revision}"`));
    expect(saved.desiredState).toBe('paused');
    const enabled = await f.uow.execute(f.owner,p => setLifecycle(p,f.owner,stored.id,{ state:'enabled',pendingRuns:'hold',reason:'Edited preview',activationPreviewId:preview.previewId },`"${saved.revision}"`));
    expect(enabled.desiredState).toBe('enabled');
  });
  test('worker metadata survives replacement and exact preview activation; new work remains assignable', async () => {
    worker = await automationPollingFixture('edit_worker');
    const f = worker;
    const created = await f.uow.execute(f.owner,p => createRule(p,f.owner,{
      ...editorInput(f.ruleInput.definition,f.ruleInput.bindingSetId,null,f.ruleInput.executionPolicyId),templateRef:'template-source',
    }));
    const activation = await f.uow.execute(f.owner,p => previewRule(p,f.owner,{ rule:editorInput(created.definition,created.bindingSetId,created),ruleId:created.id,mode:'currentState' }));
    const stored = await f.uow.execute(f.owner,p => setLifecycle(p,f.owner,created.id,{ state:'enabled',pendingRuns:'hold',reason:'Original worker',activationPreviewId:activation.previewId },`"${created.revision}"`));
    const definition = { ...stored.definition,name:'Edited worker',tasks:stored.definition.tasks.map(task => ({ ...task,instruction:'Summarize with sources.' })) };
    const input = editorInput(definition,stored.bindingSetId,stored);
    const preview = await f.uow.execute(f.owner,p => previewRule(p,f.owner,{ rule:input,ruleId:stored.id,mode:'currentState' }));
    const { templateRef:_template,...change } = input;
    const saved = await f.uow.execute(f.owner,p => replaceRule(p,f.owner,stored.id,{ ...change,pendingRuns:'hold',counterPolicy:'resetOnSemanticChange' },`"${stored.revision}"`));
    expect(saved).toMatchObject({ executionPolicyId:stored.executionPolicyId,templateRef:stored.templateRef });
    const enabled = await f.uow.execute(f.owner,p => setLifecycle(p,f.owner,stored.id,{ state:'enabled',pendingRuns:'hold',reason:'Exact worker preview',activationPreviewId:preview.previewId },`"${saved.revision}"`));
    expect(enabled.effectiveState).toBe('active');
    await f.createNode('edited-work','root','New paper','https://arxiv.org/new'); await f.inspect();
    expect((await sql`SELECT j.state FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
      JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE v.rule_id=${stored.id} AND r.explanation_json->>'nodeId'='edited-work'`.execute(f.db)).rows).toEqual([{ state:'ready' }]);
    const omitted = await f.uow.execute(f.owner,p => replaceRule(p,f.owner,stored.id,{ definition,bindingSetId:stored.bindingSetId,pendingRuns:'hold',counterPolicy:'resetOnSemanticChange' },`"${enabled.revision}"`));
    expect(omitted.executionPolicyId).toBe(stored.executionPolicyId);
    const removed = await f.uow.execute(f.owner,p => replaceRule(p,f.owner,stored.id,{ definition,bindingSetId:stored.bindingSetId,executionPolicyId:null,pendingRuns:'hold',counterPolicy:'resetOnSemanticChange' },`"${omitted.revision}"`));
    expect(removed.executionPolicyId).toBeUndefined();
  });
  test('competition changes still stale the preview, including an identical enabled rule', async () => {
    runtime = await automationRuntimeFixture('edit_competitor',true);
    const f=runtime;
    const stored = await f.uow.execute(f.owner,async p => (await p.rules.load(f.owner.accountId,f.rule.id))!.view);
    const input = { definition:stored.definition,bindingSetId:stored.bindingSetId };
    const other = await f.uow.execute(f.owner,p => createRule(p,f.owner,input));
    const preview = await f.uow.execute(f.owner,p => previewRule(p,f.owner,{ rule:input,ruleId:stored.id,mode:'currentState' }));
    const otherPreview = await f.uow.execute(f.owner,p => previewRule(p,f.owner,{ rule:input,ruleId:other.id,mode:'currentState' }));
    await f.uow.execute(f.owner,p => setLifecycle(p,f.owner,other.id,{ state:'enabled',pendingRuns:'hold',reason:'Competitor',activationPreviewId:otherPreview.previewId },`"${other.revision}"`));
    await expect(f.uow.execute(f.owner,p => setLifecycle(p,f.owner,stored.id,{ state:'enabled',pendingRuns:'hold',reason:'Old competition',activationPreviewId:preview.previewId },`"${stored.revision}"`))).rejects.toMatchObject({ code:'automation_stale_input' });
    await expect(f.uow.execute(f.owner,p => setLifecycle(p,f.owner,stored.id,{ state:'enabled',pendingRuns:'hold',reason:'Wrong identity',activationPreviewId:otherPreview.previewId },`"${stored.revision}"`))).rejects.toMatchObject({ code:'automation_stale_input' });
    const stranger=await f.issue('stranger');
    await expect(f.uow.execute(stranger,p => previewRule(p,stranger,{ rule:input,ruleId:stored.id,mode:'currentState' }))).rejects.toMatchObject({ code:'resource_not_found' });
  });
  test('archiving retains history and frees a rule slot for another configuration', async () => {
    runtime = await automationRuntimeFixture('rule_slot', true);
    const f = runtime;
    const active = await f.uow.execute(f.owner, p => p.rules.load(f.owner.accountId, f.rule.id));
    expect(await f.uow.execute(f.owner, p => p.rules.count(f.owner.accountId))).toBe(1);
    await f.uow.execute(f.owner, p => setLifecycle(p, f.owner, active!.view.id,
      { state: 'archived', pendingRuns: 'cancel', reason: 'Free a rule slot.' }, `"${active!.view.revision}"`));
    expect(await f.uow.execute(f.owner, p => p.rules.count(f.owner.accountId))).toBe(0);
    expect((await f.uow.execute(f.owner, p => p.rules.load(f.owner.accountId, f.rule.id)))?.view.desiredState).toBe('archived');
    const next = await f.uow.execute(f.owner, p => createRule(p, f.owner,
      { definition: f.rule.definition, bindingSetId: f.binding.id }));
    expect(next.desiredState).toBe('draft');
    expect(await f.uow.execute(f.owner, p => p.rules.count(f.owner.accountId))).toBe(1);
  });
});
