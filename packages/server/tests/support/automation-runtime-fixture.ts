import { sql } from 'kysely';
import { automationFixture } from './automation-fixture.js';
import { createAutomationUnitOfWork } from '../../src/infrastructure/automation/index.js';
import { createAutomationAdmission } from '../../src/infrastructure/automation/aggregate-store.js';
import { createAutomationSourceInspector, type InspectAutomationSource } from '../../src/infrastructure/automation/source-position-store.js';
import { createRule, saveBinding, previewRule, setLifecycle } from '../../src/modules/automation/index.js';
import type { OutboxHandlerContext } from '../../src/infrastructure/outbox/router.js';

export async function automationRuntimeFixture(prefix: string, runtimeEnabled = false) {
  const f = await automationFixture(prefix);
  const uow = createAutomationUnitOfWork(f.db, 'server', { runtimeEnabled });
  const configuration = await uow.execute(f.owner, async ports => {
    const binding = await saveBinding(ports, f.owner, { name: 'Runtime folders', values: f.values });
    const input = { definition: f.rule, bindingSetId: binding.id };
    const rule = await createRule(ports, f.owner, input);
    const preview = await previewRule(ports, f.owner, { rule: input, mode: 'currentState' });
    await setLifecycle(ports, f.owner, rule.id, { state: 'enabled', pendingRuns: 'hold', reason: 'Fixture enable', activationPreviewId: preview.previewId }, `"${rule.revision}"`);
    return { rule, binding };
  });
  async function inspect(consumer: InspectAutomationSource = createAutomationAdmission('server')) {
    return inspectAutomationOutbox(f.db,consumer);
  }
  return { ...f, ...configuration, uow, inspect };
}

export async function inspectAutomationOutbox(db: Awaited<ReturnType<typeof automationFixture>>['db'],consumer: InspectAutomationSource | null) {
    const row = await db.selectFrom('outbox_events').selectAll().where('handler_name', '=', 'automation_ingest')
      .orderBy('commit_ordinal', 'desc').executeTakeFirstOrThrow();
    await db.updateTable('outbox_events').set({ state: 'leased', lease_generation: 1n,
      locked_until: sql<Date>`clock_timestamp() + interval '60 seconds'` }).where('outbox_id', '=', row.outbox_id).execute();
    const context: OutboxHandlerContext = { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
      attempt: { outboxId: row.outbox_id, leaseGeneration: '1' }, envelope: { event_id: row.domain_event_id,
        event_type: row.event_type, event_version: 1, aggregate_identity: { aggregate_type: 'collection', aggregate_id: 'collection', aggregate_scope: 'collection' },
        aggregate_revision: null, commit_ordinal: String(row.commit_ordinal), occurred_at: row.occurred_at.toISOString(),
        payload: row.payload_json as OutboxHandlerContext['envelope']['payload'] } };
    const consume = createAutomationSourceInspector(db, consumer);
    while (await consume(context)) { /* bounded durable slices */ }
}
