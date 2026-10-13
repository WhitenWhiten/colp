import type { Pool } from 'pg';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import { createAutomationRuntime, createAutomationSourceInspector, createAutomationHealthMonitor } from '../../src/infrastructure/automation/index.js';
import { PostgresOutboxRepository, VersionedOutboxWorker, OutboxRouter, EventEnvelopeRegistry,
  createAutomationIngestRoute, automationIngestRegistration, automationResumeRegistration, AUTOMATION_RESUME_EVENT,
  PostgresCollectionMutationProjectionSink, createCollectionMutationOutboxRoutes, createCollectionMutationEnvelopeRegistrations,
  type OutboxRepository } from '../../src/infrastructure/outbox/index.js';

/** Real durable routes; no fixture ever marks another handler's rows completed. */
export function automationMixedWorker(db: Kysely<DatabaseSchema>, pool: Pool, options: {
  repository?: OutboxRepository; onSlice?: (elapsedMs: number) => void;
} = {}) {
  const runtime = createAutomationRuntime('server');
  const inspect = createAutomationSourceInspector(db, runtime);
  const measured: typeof inspect = async context => {
    const start = performance.now();
    try { return await inspect(context); }
    finally { options.onSlice?.(performance.now() - start); }
  };
  const projection = new PostgresCollectionMutationProjectionSink(pool);
  const health = createAutomationHealthMonitor(db, 'server', undefined, true);
  const worker = new VersionedOutboxWorker({
    repository: options.repository ?? new PostgresOutboxRepository(pool),
    router: new OutboxRouter([
      ...createCollectionMutationOutboxRoutes({ sink: health.wrap(projection) }),
      createAutomationIngestRoute(measured), createAutomationIngestRoute(measured, AUTOMATION_RESUME_EVENT),
    ]),
    envelopes: new EventEnvelopeRegistry([
      ...createCollectionMutationEnvelopeRegistrations(), automationIngestRegistration, automationResumeRegistration,
    ]),
    logger: { info() {}, warn() {}, error() {} },
    leaseDurationMs: 30000, heartbeatIntervalMs: 5000, handlerTimeoutMs: 20000,
    retryPolicy: { maxAttempts: 5, retryDelayMs: () => 1 },
  });
  return { worker, projection };
}
