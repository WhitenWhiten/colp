import { afterEach, expect, test } from 'vitest';
import type { KyselyPlugin } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/unit-of-work.js';
import { createRunStore } from '../../../src/infrastructure/automation/run-store.js';

describeWithPostgres('Automation bounded read query budgets', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('shared ancestry and a populated history page use bounded query counts', async () => {
    f = await automationPollingFixture('automation_read_budget');
    for (let i = 0; i < 25; i++) await f.createNode(`read-${i}`, 'root', `Member ${i}`, `https://arxiv.org/read-${i}`);
    await f.inspect();
    let queries = 0;
    const plugin: KyselyPlugin = {
      transformQuery: ({ node }) => { queries++; return node; },
      transformResult: async ({ result }) => result,
    };
    const counted = f.db.withPlugin(plugin);
    const uow = createAutomationUnitOfWork(counted, 'server', { runtimeEnabled: true });
    const sample = await uow.execute(f.owner, async ports => {
      const binding = (await ports.bindings.load(f.owner.accountId, f.ruleInput.bindingSetId))!;
      return ports.sample(f.owner, f.ruleInput.definition, binding.values);
    });
    expect(sample.events).toHaveLength(27);
    expect(queries).toBeLessThan(30);
    queries = 0;
    const runs = await counted.transaction().execute(tx => createRunStore(tx,f.owner,'server').list(null,100));
    expect(runs.length).toBeGreaterThan(20);
    expect(runs.every(run => run.view.jobIds.length > 0 && run.view.usage !== undefined)).toBe(true);
    expect(queries).toBeLessThan(15);
    const detail = await f.uow.execute(f.owner, ports => ports.runs.load(runs[0]!.view.id));
    expect(runs[0]!.view.effects).toEqual(detail!.view.effects);
    expect(runs[0]!.view.unread).toBe(detail!.view.unread);
  });
});
