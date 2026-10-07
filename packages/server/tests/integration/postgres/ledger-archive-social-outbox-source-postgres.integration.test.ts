import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

import { createMigrator } from '../../../src/infrastructure/database/migrations.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveColdReader,
  createLedgerArchiveExporter,
  createPostgresSocialOutboxLedgerArchiveSource,
  SocialOutboxArchiveSourceError,
} from '../../../src/infrastructure/ledger-archive/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('social Outbox production archive source', () => {
  let isolated: IsolatedPostgresRuntime;
  let objectRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('social_outbox_archive', { maxConnections: 8 });
    const migrated = await createMigrator(
      isolated.runtime.db, 'migrations', isolated.schema,
    ).migrateToLatest();
    if (migrated.error) throw migrated.error;
    objectRoot = await mkdtemp(join(tmpdir(), 'known-social-outbox-archive-'));
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  });

  test('groups duplicate ordinals losslessly and exports old completed rows to verified filesystem storage', async () => {
    const scope = `social-archive-${randomUUID()}`;
    await seedSocialOutbox(isolated, scope, 'event-001', 'outbox-001', 1n,
      '{"amount":1.00,"z":"中","a":9007199254740991}', '2025-01-01T00:00:00.000Z');
    await seedSocialOutbox(isolated, scope, 'event-002-a', 'outbox-002-b', 2n,
      '{"marker":"first"}', '2025-01-02T00:00:00.000Z');
    await seedSocialOutbox(isolated, scope, 'event-002-b', 'outbox-002-a', 2n,
      '{"marker":"second"}', '2025-01-02T00:00:01.000Z');
    await advanceFloor(isolated, scope, 2n, 'event-002-b');

    const source = await createPostgresSocialOutboxLedgerArchiveSource(isolated.runtime.db, scope);
    assert.equal(source.ledgerFamily, 'outbox_social');
    assert.equal(source.sourceRelation, 'public.outbox_events');
    const firstPage = await source.readPage({
      bounds: { lowerInclusive: 1n, upperExclusive: 3n }, limit: 1,
    });
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.rows[0]!.events[0]!.canonicalPayloadJson.includes('1.00'), true);

    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const store = createFilesystemLedgerArchiveObjectStore({
      rootDirectory: objectRoot, kmsKeyId: 'dev:social-outbox',
    });
    const segment = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'), pageSize: 1,
    }).export({
      segmentId: randomUUID(), source, lowerInclusive: 1n, upperExclusive: 3n,
      kmsKeyId: 'dev:social-outbox',
    });
    assert.equal(segment.state, 'verified');
    assert.equal(segment.rowCount, 2n);

    const rows: Array<{ key: bigint; value: unknown }> = [];
    await createLedgerArchiveColdReader({
      segments, objects: store, byteCeiling: 10_000_000n,
    }).readRows(segment.segmentId, (row) => rows.push(row));
    assert.deepEqual(rows.map((row) => row.key), [1n, 2n]);
    const second = rows[1]!.value as { events: Array<{
      domainEventId: string; outboxId: string; canonicalPayloadJson: string;
      payloadDigest: string; canonicalEventEnvelopeJson: string; envelopeDigest: string;
      state: string;
    }> };
    assert.deepEqual(second.events.map((event) => [event.domainEventId, event.outboxId]), [
      ['event-002-a', 'outbox-002-b'], ['event-002-b', 'outbox-002-a'],
    ]);
    for (const event of second.events) {
      assert.equal(event.state, 'completed');
      assert.match(event.payloadDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.match(event.envelopeDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.doesNotThrow(() => JSON.parse(event.canonicalPayloadJson));
      assert.doesNotThrow(() => JSON.parse(event.canonicalEventEnvelopeJson));
    }
  });

  test('fails closed on a gap, unresolved row, malformed bounds, and wrong scope', async () => {
    await assert.rejects(
      () => createPostgresSocialOutboxLedgerArchiveSource(isolated.runtime.db, 'missing scope'),
      (error: unknown) => error instanceof SocialOutboxArchiveSourceError
        && error.stableCode === 'archive_source_scope_invalid',
    );
    await assert.rejects(
      () => createPostgresSocialOutboxLedgerArchiveSource(isolated.runtime.db, 'missing-scope'),
      (error: unknown) => error instanceof SocialOutboxArchiveSourceError
        && error.stableCode === 'archive_source_outbox_scope_not_ready',
    );

    const gapScope = `social-gap-${randomUUID()}`;
    await seedSocialOutbox(isolated, gapScope, 'gap-event-001', 'gap-outbox-001', 1n,
      '{}', '2025-01-01T00:00:00.000Z');
    await seedSocialOutbox(isolated, gapScope, 'gap-event-003', 'gap-outbox-003', 3n,
      '{}', '2025-01-03T00:00:00.000Z');
    await advanceFloor(isolated, gapScope, 3n, 'gap-event-003');
    const gapSource = await createPostgresSocialOutboxLedgerArchiveSource(isolated.runtime.db, gapScope);
    await assert.rejects(
      () => gapSource.readPage({ bounds: { lowerInclusive: 1n, upperExclusive: 4n }, limit: 10 }),
      (error: unknown) => error instanceof SocialOutboxArchiveSourceError
        && error.stableCode === 'archive_source_outbox_range_not_dense',
    );
    await assert.rejects(
      () => gapSource.readPage({ bounds: { lowerInclusive: 2n, upperExclusive: 4n }, limit: 10 }),
      (error: unknown) => error instanceof SocialOutboxArchiveSourceError
        && error.stableCode === 'archive_source_outbox_bounds_invalid',
    );

    const unresolvedScope = `social-unresolved-${randomUUID()}`;
    await seedSocialOutbox(isolated, unresolvedScope, 'unresolved-event', 'unresolved-outbox', 1n,
      '{}', '2025-01-01T00:00:00.000Z');
    await advanceFloor(isolated, unresolvedScope, 1n, 'unresolved-event');
    const unresolved = await createPostgresSocialOutboxLedgerArchiveSource(
      isolated.runtime.db, unresolvedScope,
    );
    await isolated.runtime.pool.query(
      'alter table outbox_events disable trigger outbox_events_retention_floor_state_guard',
    );
    try {
      await isolated.runtime.pool.query(`update outbox_events set state='pending',completed_at=null
        where aggregate_scope=$1`, [unresolvedScope]);
    } finally {
      await isolated.runtime.pool.query(
        'alter table outbox_events enable trigger outbox_events_retention_floor_state_guard',
      );
    }
    await assert.rejects(
      () => unresolved.readPage({ bounds: { lowerInclusive: 1n, upperExclusive: 2n }, limit: 10 }),
      (error: unknown) => error instanceof SocialOutboxArchiveSourceError
        && error.stableCode === 'archive_source_outbox_unresolved',
    );
  });
});

async function seedSocialOutbox(
  isolated: IsolatedPostgresRuntime,
  scope: string,
  domainEventId: string,
  outboxId: string,
  ordinal: bigint,
  payloadJson: string,
  occurredAt: string,
): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values($1,'domain_event'),($2,'outbox')`, [domainEventId, outboxId]);
  await isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
      occurred_at,payload_json,state,attempt_count,available_at,lease_generation,completed_at)
    values($1,$2,'social.collection-change',2,'social.publish-collection-change',
      'projection_latest_only','collection',$3,$3,'revision',$4,$5,$6::jsonb,
      'completed',1,$5,1,$5)`, [
    outboxId, domainEventId, scope, ordinal.toString(), occurredAt, payloadJson,
  ]);
}

async function advanceFloor(
  isolated: IsolatedPostgresRuntime,
  scope: string,
  ordinal: bigint,
  domainEventId: string,
): Promise<void> {
  await isolated.runtime.pool.query(`insert into outbox_retention_floors(
    handler_name,event_type,aggregate_scope) values(
    'social.publish-collection-change','social.collection-change',$1)`, [scope]);
  await isolated.runtime.pool.query(`update outbox_retention_floors set
      floor_commit_ordinal=$2,floor_domain_event_id=$3,state_revision=1
    where handler_name='social.publish-collection-change'
      and event_type='social.collection-change' and aggregate_scope=$1`, [
    scope, ordinal.toString(), domainEventId,
  ]);
}
