import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { Pool } from 'pg';
import {
  createPostgresOutboxRetentionFloorRepository,
  OutboxRetentionFloorError,
} from '../../../src/infrastructure/outbox/index.js';

const migrationUrl = new URL(
  '../../../migrations/202610010200_outbox_retention_floors.ts', import.meta.url,
);

test('retention migration installs permanent claims, insert trigger, FK and monotonic floor guards',
  async () => {
    const source = await readFile(migrationUrl, 'utf8');
    for (const required of [
      'CREATE TABLE outbox_dispatch_claims',
      'INSERT INTO outbox_dispatch_claims',
      'AFTER INSERT ON outbox_events',
      'outbox_events_dispatch_claim_fk',
      'outbox_dispatch_claims_immutable_row',
      'outbox_dispatch_claims_immutable_truncate',
      'outbox_dispatch_claims_outbox_id_key UNIQUE (outbox_id)',
      'outbox_dispatch_claims_permanent_once',
      'CREATE TABLE outbox_retention_floors',
      'outbox_retention_floors_transition_guard',
      'outbox_retention_floors_unresolved_source',
      'outbox_retention_floors_boundary_missing',
      'outbox_retention_unresolved_source_idx',
      'outbox_events_below_retention_floor',
      'outbox_events_below_floor_unresolved',
      'outbox_events_source_identity_immutable',
      'outbox_retention_floors_policy_unsupported',
      'outbox_retention_floors_policy_window',
      "current_timestamp - interval '90 days'",
      'social_feed_watermarks_rebuild_high_source_shape',
      'social_feed_watermarks_rebuild_high_source_transition',
      'BEFORE TRUNCATE ON outbox_retention_floors',
    ]) assert.ok(source.includes(required), required);
    assert.ok(source.indexOf('AFTER INSERT ON outbox_events')
      < source.indexOf('await sql`INSERT INTO outbox_dispatch_claims'),
    'insert trigger must close the writer race before snapshot backfill');
    assert.equal(/delete\s+from\s+outbox_events/iu.test(source), false,
      'floor authority migration must not delete Outbox history');
    const claimFunction = source.slice(source.indexOf('CREATE FUNCTION claim_outbox'),
      source.indexOf('CREATE TRIGGER outbox_events_claim'));
    assert.match(claimFunction,
      /IF NEW\.aggregate_scope IS NOT NULL AND NEW\.commit_ordinal IS NOT NULL THEN\s+PERFORM pg_advisory_xact_lock/iu,
    'late inserts must lock before reading a possibly first-materialized floor');
    const updateFunction = source.slice(source.indexOf('CREATE FUNCTION guard_outbox_source'),
      source.indexOf('CREATE TRIGGER outbox_events_retention'));
    assert.match(updateFunction,
      /IF NEW\.aggregate_scope IS NOT NULL AND NEW\.commit_ordinal IS NOT NULL THEN\s+PERFORM pg_advisory_xact_lock/iu,
    'state updates must lock before reading a possibly first-materialized floor');
  });

test('retention repository returns stable validation errors before issuing SQL', async () => {
  const forbiddenPool = Object.freeze({
    query(): never { throw new Error('query must not execute'); },
  }) as unknown as Pool;
  const repository = createPostgresOutboxRetentionFloorRepository(forbiddenPool);
  await assert.rejects(repository.read({ handlerName: '', eventType: 'event',
    aggregateScope: 'scope' }), (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_INVALID');
  await assert.rejects(repository.advance({ handlerName: 'handler', eventType: 'event',
    aggregateScope: 'scope', position: { commitOrdinal: '0', domainEventId: null },
    expectedStateRevision: '0' }),
  (error: unknown) => error instanceof OutboxRetentionFloorError
    && error.code === 'OUTBOX_RETENTION_FLOOR_INVALID');
});

// The social Feed rebuild-density contract left with the social module
// (`src/infrastructure/social/feed-worker-postgres.ts`; see tests/EXTRACTION.md).

test('Outbox owns a readable composed database-schema slice with compatible public types',
  async () => {
    const [runtime, tables, databaseIndex] = await Promise.all([
      readFile(new URL('../../../src/infrastructure/database/runtime.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/infrastructure/database/outbox-tables.ts', import.meta.url),
        'utf8'),
      readFile(new URL('../../../src/infrastructure/database/index.ts', import.meta.url), 'utf8'),
    ]);
    const schemaExtends = runtime.match(/interface\s+DatabaseSchema\s+extends\s+([^{]+)/u);
    assert.ok(schemaExtends?.[1], 'DatabaseSchema must declare an extends list');
    const extended = schemaExtends[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0);
    assert.ok(
      extended.includes('OutboxDatabaseSchema'),
      `DatabaseSchema extends list must include OutboxDatabaseSchema, got ${extended.join(', ')}`,
    );
    assert.doesNotMatch(runtime, /outbox_events:[^\n]+outbox_dispatch_claims/iu);
    for (const tableType of ['OutboxEventTable', 'OutboxDispatchClaimTable',
      'OutboxRetentionFloorTable', 'OutboxDatabaseSchema']) {
      assert.ok(tables.includes(`interface ${tableType}`), tableType);
    }
    assert.match(runtime, /export type \{ OutboxEventTable \} from '.\/outbox-tables\.js'/u);
    assert.match(databaseIndex, /OutboxDatabaseSchema,[\s\S]*from '.\/outbox-tables\.js'/u);
  });
