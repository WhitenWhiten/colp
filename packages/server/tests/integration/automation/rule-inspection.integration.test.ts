import { afterEach, expect, test } from 'vitest';
import type { KyselyPlugin } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createRule, saveBinding, previewRule, setLifecycle } from '../../../src/modules/automation/index.js';
import { moveCollectionNode } from '../../../src/modules/collections/index.js';

describeWithPostgres('Rule inspection read scope', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  test('distinct binding sets sharing folders stay bounded, and later canonical changes invalidate activation', async () => {
    f = await automationRuntimeFixture('rule_inspection_budget', true);
    for (let i = 0; i < 20; i++) await f.uow.execute(f.owner, async ports => {
      const binding = await saveBinding(ports, f.owner, { name: `Binding ${i}`, values: f.values });
      const input = { definition: { ...f.rule.definition, name: `Rule ${i}` }, bindingSetId: binding.id };
      const rule = await createRule(ports, f.owner, input);
      const preview = await previewRule(ports, f.owner, { rule: input, mode: 'currentState' });
      await setLifecycle(ports, f.owner, rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Test competition', activationPreviewId: preview.previewId }, `"${rule.revision}"`);
    });
    let queries = 0;
    const plugin: KyselyPlugin = { transformQuery: ({ node }) => { queries++; return node; }, transformResult: async ({ result }) => result };
    const uow = createAutomationUnitOfWork(f.db.withPlugin(plugin), 'server', { runtimeEnabled: true });
    const input = { rule: { definition: f.rule.definition, bindingSetId: f.binding.id }, mode: 'currentState' };
    const before = await uow.execute(f.owner, ports => previewRule(ports, f.owner, input));
    expect(queries).toBeLessThan(120); // Includes 20 distinct binding reads; folder authority is shared only within this pass.
    const node = await f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'academic').executeTakeFirstOrThrow();
    const parents = await f.db.selectFrom('nodes').select(['id', 'children_revision']).where('id', 'in', ['parent', 'root']).execute();
    const revisions = new Map(parents.map(p => [p.id, p.children_revision]));
    await f.canonical.execute(ports => moveCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      nodeId: 'academic', ifMatch: `"${node.resource_revision}"`, newParentId: 'root', afterId: null, beforeId: null,
      baseSourceParentRevision: revisions.get('parent')!, baseTargetParentRevision: revisions.get('root')! }));
    await expect(f.uow.execute(f.owner, async ports => {
      const current = (await ports.rules.load(f.owner.accountId, f.rule.id))!;
      return setLifecycle(ports, f.owner, f.rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Old preview', activationPreviewId: before.previewId }, `"${current.view.revision}"`);
    })).rejects.toMatchObject({ code: 'automation_stale_input' });
    const after = await f.uow.execute(f.owner, ports => previewRule(ports, f.owner, input));
    const digests = await f.uow.execute(f.owner, async ports => [
      (await ports.previews.load(f.owner.accountId, before.previewId))!.configDigest,
      (await ports.previews.load(f.owner.accountId, after.previewId))!.configDigest,
    ]);
    expect(digests[0]).not.toBe(digests[1]);
  });
});
