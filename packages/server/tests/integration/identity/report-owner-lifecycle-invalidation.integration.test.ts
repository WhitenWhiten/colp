import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountRepository } from '../../../src/infrastructure/identity/index.js';
import {
  appendReportOutboxEvent,
  createPostgresReportSourceInvalidationOutboxPort,
} from '../../../src/infrastructure/outbox/index.js';
import { createPostgresReportMemberWritePort } from '../../../src/infrastructure/reports/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('report owner lifecycle cache invalidation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('report_owner_lifecycle', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('account deletion emits both source and owned-series purge events in one transaction', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`INSERT INTO accounts(id, subject_id, status) VALUES ('owner-account', 'owner-subject', 'active')`);
      await client.query(`INSERT INTO resource_id_ledger(resource_id, resource_type)
        VALUES ('owner-series', 'digest_series'), ('owner-source', 'collection'), ('owner-root', 'node')`);
      await client.query(`INSERT INTO collections(
        id, owner_subject_id, title, kind, visibility, root_node_id,
        resource_revision, content_revision, policy_revision, commit_ordinal
      ) VALUES ('owner-source', 'owner-subject', 'Source', 'bookmarks', 'private',
        'owner-root', 'r1', 'c1', 'p1', 1)`);
      await client.query(`INSERT INTO nodes(
        id, collection_id, kind, is_root, title, resource_revision, children_revision
      ) VALUES ('owner-root', 'owner-source', 'folder', true, 'Root', 'r1', 'c1')`);
      await client.query(`INSERT INTO digest_series(
        id, owner_subject_id, title, slug, visibility, allow_search_indexing,
        state, resource_revision, content_revision, policy_revision, commit_ordinal
      ) VALUES ('owner-series', 'owner-subject', 'Report', 'owner-report', 'public',
        true, 'active', 'sr1', 'sc1', 'sp1', 1)`);
      await client.query(`INSERT INTO digest_members(series_id, subject_id, role)
        VALUES ('owner-series', 'owner-subject', 'owner')`);
      await client.query(`INSERT INTO accounts(id, subject_id, status)
        VALUES ('member-account', 'member-subject', 'active'),
               ('revoked-account', 'revoked-subject', 'active')`);
      await client.query(`INSERT INTO digest_members(series_id, subject_id, role, revoked_at)
        VALUES ('owner-series', 'member-subject', 'viewer', NULL),
               ('owner-series', 'revoked-subject', 'viewer', current_timestamp)`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const membersBeforeDelete = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportMemberWritePort(transaction).list('owner-series', 101));
    assert.deepEqual(membersBeforeDelete.map((member) => member.subjectId), [
      'owner-subject', 'member-subject',
    ]);
    await isolated.runtime.pool.query(
      `UPDATE accounts SET status = 'active', deleted_at = current_timestamp WHERE id = 'member-account'`,
    );
    const membersAfterMemberDelete = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportMemberWritePort(transaction).list('owner-series', 101));
    assert.deepEqual(membersAfterMemberDelete.map((member) => member.subjectId), ['owner-subject']);

    const invalidation = createPostgresReportSourceInvalidationOutboxPort();
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresAccountRepository(transaction, { reportSourceInvalidation: invalidation })
        .markDeleted('owner-account', new Date('2026-09-04T00:00:00.000Z')));

    const events = await isolated.runtime.pool.query<{
      event_type: string;
      domain_event_id: string;
      payload_json: Record<string, unknown>;
    }>(`SELECT event_type, domain_event_id, payload_json
          FROM outbox_events
         WHERE domain_event_id LIKE 'identity:account-deleted%'
         ORDER BY event_type`);
    assert.equal(events.rows.length, 2);
    assert.ok(events.rows.some((row) => row.event_type === 'reports.source.invalidated@1'));
    const purge = events.rows.find((row) => row.event_type === 'reports.public_surface_purge.requested@1');
    assert.equal(purge?.payload_json.slug, 'owner-report');
    const progress = await isolated.runtime.pool.query(
      `SELECT collection_id FROM digest_source_invalidation_progress
        WHERE domain_event_id = 'identity:account-deleted:owner-account:owner-source'`);
    assert.equal(progress.rows[0]?.collection_id, 'owner-source');

    // Replays must retain the immutable outbox identity, including the
    // persisted ordinal/metadata, rather than silently accepting a changed
    // ordering fence under the same outbox ID.
    await assert.rejects(
      () => createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        invalidation.append(transaction, {
          domainEventId: 'identity:account-deleted:owner-account:owner-source',
          collectionId: 'owner-source', sourceEventType: 'identity.account.lifecycle',
          sourceEventVersion: 1, contentRevision: 'c1', policyRevision: 'p1', commitOrdinal: 2n,
        })),
      /outbox (?:id )?collision/u,
    );

    const reportEvent = {
      outboxId: 'report-event-outbox', eventId: 'report-event-domain',
      eventType: 'reports.series.changed@1' as const, eventVersion: 1 as const,
      handlerName: 'reports_projection', handlerMode: 'projection_latest_only' as const,
      occurredAt: new Date('2026-09-04T00:00:00.000Z'),
      payload: {
        contentRevision: 'sc1', policyRevision: 'sp1', resourceRevision: 'sr1',
        seriesId: 'owner-series', state: 'active' as const, visibility: 'public' as const,
      },
    };
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      appendReportOutboxEvent(transaction, reportEvent));
    await assert.rejects(
      () => createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        appendReportOutboxEvent(transaction, {
          ...reportEvent,
          occurredAt: new Date('2026-09-04T00:00:01.000Z'),
        })),
      /outbox (?:id )?collision/u,
    );

    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `TRUNCATE digest_source_invalidation_progress, outbox_events, digest_members,
       digest_series, digest_schedules, digest_runs, nodes, collections, accounts,
       resource_id_ledger CASCADE`);
  });
});
