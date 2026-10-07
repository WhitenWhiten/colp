/**
 * P4A-P05 shared helpers for the composition-focused suite (test-owned, not a
 * vitest test file). These helpers keep the suite file bounded while staying
 * on the PRODUCTION assembly: `createP05CompositionWorker` builds the exact
 * production `buildWorker` composition (verification outbox route + cleanup
 * scheduler + backlog telemetry) over the production R2 adapter pointed at
 * the local object server; `driveP05OutboxUntil` drives the production outbox
 * loop with bounded real-time polling; `p05VerificationReceiptCount` observes
 * the delivery receipts as an independent fact.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { buildWorker, type WorkerRuntime } from '../../src/bootstrap/worker.js';
import { loadConfig } from './test-config.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import type { BlobStorePort } from '../../src/infrastructure/object-storage/index.js';
import type { AttachmentAlertConfig } from '../../src/modules/attachments/index.js';
import { waitForCondition } from './async-test-helpers.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import { P05ObjectServer } from './phase4a-p05-object-server.js';
import { createP05ObjectStore, makeP05Config, p05WorkerEnvironment } from './phase4a-p05-test-helpers.js';

const CONFIG = makeP05Config();

export interface P05CompositionWorkerOverrides {
  readonly database?: I07MigrationRuntime['runtime'];
  readonly metrics?: InMemoryMetrics;
  readonly cleanupIntervalMs?: number;
  readonly telemetryIntervalMs?: number;
  readonly alertConfig?: AttachmentAlertConfig;
  readonly now?: () => Date;
  readonly workerId?: string;
}

export interface P05CompositionWorker {
  readonly runtime: WorkerRuntime;
  readonly metrics: InMemoryMetrics;
  readonly store: BlobStorePort;
}

/** Builds the PRODUCTION worker composition over the local object server. */
export function createP05CompositionWorker(
  isolated: I07MigrationRuntime,
  objectServer: P05ObjectServer,
  overrides: P05CompositionWorkerOverrides = {},
): P05CompositionWorker {
  const metrics = overrides.metrics ?? new InMemoryMetrics();
  const store = createP05ObjectStore(objectServer.url, CONFIG);
  const runtime = buildWorker(
    loadConfig(p05WorkerEnvironment(isolated.databaseUrl)),
    overrides.database ?? isolated.runtime,
    metrics,
    {
      attachmentsObjectStorage: store,
      attachmentsCleanupIntervalMs: overrides.cleanupIntervalMs ?? 60_000,
      attachmentsTelemetryIntervalMs: overrides.telemetryIntervalMs ?? 30_000,
      ...(overrides.alertConfig === undefined ? {} : { attachmentsAlertConfig: overrides.alertConfig }),
      ...(overrides.now === undefined ? {} : { attachmentsNow: overrides.now }),
      ...(overrides.workerId === undefined ? {} : { attachmentsWorkerId: overrides.workerId }),
    },
  );
  assert.ok(runtime.attachments, 'attachments worker surface must be composed');
  return { runtime, metrics, store };
}

/** Drives the production outbox loop until the predicate holds (bounded). */
export async function driveP05OutboxUntil(
  runtime: WorkerRuntime,
  predicate: () => Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly label?: string } = {},
): Promise<void> {
  const label = options.label ?? 'predicate';
  let lastError: unknown;
  try {
    await waitForCondition(async () => {
      if (await predicate()) return true;
      try {
        await runtime.outbox?.runOnce();
      } catch (error) {
        // Loop-level failures are isolated; the next iteration retries.
        lastError = error;
      }
      return false;
    }, {
      timeoutMs: options.timeoutMs ?? 60_000,
      pollIntervalMs: 250,
      description: `P05 outbox convergence: ${label}`,
    });
  } catch (error) {
    throw new Error(`driveP05OutboxUntil timed out: ${label}`, { cause: lastError ?? error });
  }
}

/** Independent observation: delivery receipts for one blob's verification. */
export async function p05VerificationReceiptCount(
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count
    from outbox_delivery_receipts r
    join outbox_events e on e.domain_event_id = r.domain_event_id
    where r.handler_name = 'attachments_verify_generation' and e.aggregate_id = ${blobId}
  `.execute(runtime.db);
  return Number(result.rows[0]!.count);
}

/**
 * Inserts a real unrelated outbox event (publication cache purge, noop
 * provider in the test env) so suites can prove attachments failures never
 * disable other routes. Returns the outbox id and the domain event id.
 */
export async function insertP05UnrelatedPurgeEvent(
  runtime: I07MigrationRuntime['runtime'],
  collectionId: string,
): Promise<{ readonly purgeId: string; readonly eventId: string }> {
  const purgeId = randomUUID();
  const eventId = `${purgeId}-event`;
  await runtime.pool.query(
    `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'outbox'), ($2, 'outbox')`,
    [purgeId, eventId],
  );
  await runtime.pool.query(
    `insert into outbox_events (
       outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
       aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
       occurred_at, payload_json, state, attempt_count, available_at, locked_until,
       lease_generation, completed_at, last_error, dead_lettered_at)
     values ($1, $2, 'publication.cache_purge.requested', 2, 'publication_cache_purge',
       'delivery_each_event', 'publication', $3, null, null, null, now(), $4,
       'pending', 0, now(), null, 0, null, null, null)`,
    [purgeId, eventId, collectionId, JSON.stringify({
      collectionId, contentRevision: 'c1', policyRevision: 'p1',
      publicationSlug: 'p05-slug', sourceEventType: 'collection.updated',
      sourceEventVersion: 1, visibility: 'private',
    })],
  );
  return { purgeId, eventId };
}

/** Independent observation: delivery receipts for the unrelated purge event. */
export async function p05PurgeReceiptCount(
  runtime: I07MigrationRuntime['runtime'],
  eventId: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from outbox_delivery_receipts
    where handler_name = 'publication_cache_purge' and domain_event_id = ${eventId}
  `.execute(runtime.db);
  return Number(result.rows[0]!.count);
}
