import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';

import {
  createMigrator,
  createPostgresLedgerArchiveSegmentRepository,
  LedgerArchiveSegmentRepositoryError,
  runMigrations,
  type CreateLedgerArchiveSegmentInput,
  type LedgerArchiveSegmentState,
} from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const STATES: readonly LedgerArchiveSegmentState[] = Object.freeze([
  'open', 'sealed', 'exported', 'verified', 'reader_cutover', 'detached', 'deletable', 'deleted',
]);

function manifest(overrides: Partial<CreateLedgerArchiveSegmentInput> = {}): CreateLedgerArchiveSegmentInput {
  return {
    segmentId: randomUUID(),
    ledgerFamily: 'operations',
    sourceRelation: 'public.operations',
    sourceScope: `test:${randomUUID()}`,
    sourceKeyKind: 'bigint',
    sourceKeyComparator: 'signed-bigint-ascending-v1',
    sourceKeyBounds: { lowerInclusive: 100n, upperExclusive: 200n },
    rowCount: 100n,
    sourceBytes: 4096n,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    archiveObjectUri: 's3://known-ledgers/operations/100-200.parquet',
    archiveObjectEtag: 'immutable-etag-1',
    archiveSchemaVersion: 1,
    kmsKeyId: 'kms:known:ledger-archive-v1',
    deleteAfter: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function isRepositoryError(code: LedgerArchiveSegmentRepositoryError['code']) {
  return (error: unknown): boolean => error instanceof LedgerArchiveSegmentRepositoryError
    && error.code === code;
}

describeWithPostgres('ledger archive segment control plane', () => {
  let isolated: IsolatedPostgresRuntime;
  let repository: ReturnType<typeof createPostgresLedgerArchiveSegmentRepository>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_archive_segments', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    repository = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('legal full path records ordered timestamps and evidence without touching source ledgers', async () => {
    let segment = await repository.create(manifest());
    assert.equal(segment.state, 'open');
    assert.equal(segment.stateRevision, 1n);
    assert.match(segment.sourceScope, /^test:/u);
    assert.equal(segment.sourceKeyKind, 'bigint');
    assert.equal(segment.sourceKeyComparator, 'signed-bigint-ascending-v1');

    for (const targetState of STATES.slice(1)) {
      segment = await repository.transition({
        segmentId: segment.segmentId,
        expectedState: segment.state,
        expectedRevision: segment.stateRevision,
        targetState,
        evidence: { changeId: `${targetState}-change`, verifiedBy: 'integration-test' },
      });
    }

    assert.equal(segment.state, 'deleted');
    assert.equal(segment.stateRevision, 8n);
    assert.deepEqual(
      new Set(Object.keys(segment.stageEvidence)),
      new Set(STATES.slice(1)),
    );
    const times = [
      segment.sealedAt, segment.exportedAt, segment.verifiedAt, segment.readerCutoverAt,
      segment.detachedAt, segment.deletableAt, segment.deletedAt,
    ];
    assert.ok(times.every((value) => value instanceof Date));
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index]!.getTime() >= times[index - 1]!.getTime());
    }

    const sourceCounts = await isolated.runtime.pool.query<{ operations: string; audits: string; outbox: string }>(`
      select
        (select count(*)::text from operations) operations,
        (select count(*)::text from audit_events) audits,
        (select count(*)::text from outbox_events) outbox
    `);
    assert.deepEqual(sourceCounts.rows[0], { operations: '0', audits: '0', outbox: '0' });
  });

  test('database rejects skipping verified, rollback, and sealed manifest mutation', async () => {
    const created = await repository.create(manifest());

    await assert.rejects(
      () => isolated.runtime.pool.query(`
        update ledger_archive_segments
           set state='reader_cutover', state_revision=state_revision+1,
               stage_evidence=stage_evidence || '{"reader_cutover":{"change":"bad"}}'::jsonb
         where segment_id=$1
      `, [created.segmentId]),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'ledger_archive_segments_transition_guard',
    );

    const sealed = await repository.transition({
      segmentId: created.segmentId,
      expectedState: 'open',
      expectedRevision: 1n,
      targetState: 'sealed',
      evidence: { manifest: 'captured' },
    });
    await assert.rejects(
      () => isolated.runtime.pool.query(`
        update ledger_archive_segments
           set state='open', state_revision=state_revision+1,
               stage_evidence=stage_evidence || '{"open":{"change":"bad"}}'::jsonb
         where segment_id=$1
      `, [sealed.segmentId]),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'ledger_archive_segments_transition_guard',
    );
    await assert.rejects(
      () => isolated.runtime.pool.query(`
        update ledger_archive_segments
           set row_count=row_count+1, state_revision=state_revision+1
         where segment_id=$1
      `, [sealed.segmentId]),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'ledger_archive_segments_manifest_immutable',
    );
  });

  test('database permanently rejects direct manifest deletion', async () => {
    const created = await repository.create(manifest());
    await assert.rejects(
      () => isolated.runtime.pool.query(
        'delete from ledger_archive_segments where segment_id=$1',
        [created.segmentId],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'ledger_archive_segments_delete_guard',
    );
    assert.equal((await repository.get(created.segmentId))?.state, 'open');
  });

  test('database permanently rejects truncating all manifest evidence', async () => {
    const created = await repository.create(manifest());
    await assert.rejects(
      () => isolated.runtime.pool.query('truncate table ledger_archive_segments'),
      (error: unknown) => (error as { constraint?: string; code?: string }).constraint
        === 'ledger_archive_segments_truncate_guard'
        || (error as { code?: string }).code === '0A000',
    );
    assert.equal((await repository.get(created.segmentId))?.state, 'open');
  });

  test('constraints reject overlap, malformed digest/URI, and invalid bounds', async () => {
    const overlapScope = `overlap:${randomUUID()}`;
    const first = await repository.create(manifest({ sourceScope: overlapScope }));
    const otherScope = await repository.create(manifest({
      segmentId: randomUUID(),
      sourceScope: 'collection:0191ccee-6410-7cb3-a7df-b20d320272c9',
    }));
    assert.equal(otherScope.sourceScope, 'collection:0191ccee-6410-7cb3-a7df-b20d320272c9');
    assert.equal((await repository.get(first.segmentId))?.sourceScope, overlapScope);
    const pendingIds = new Set((await repository.listPending({ limit: 500 }))
      .map((segment) => segment.segmentId));
    assert.ok(pendingIds.has(first.segmentId));
    assert.ok(pendingIds.has(otherScope.segmentId));
    await assert.rejects(
      () => repository.create(manifest({
        segmentId: randomUUID(),
        sourceScope: overlapScope,
        sourceKeyBounds: { lowerInclusive: 150n, upperExclusive: 250n },
      })),
      isRepositoryError('segment_overlap'),
    );
    await assert.rejects(
      () => repository.create(manifest({ segmentId: randomUUID(), contentDigest: 'sha256:nope' })),
      isRepositoryError('invalid_segment'),
    );
    await assert.rejects(
      () => repository.create(manifest({
        segmentId: randomUUID(),
        sourceKeyBounds: { lowerInclusive: 300n, upperExclusive: 400n },
        archiveObjectUri: 's3://access:secret@known-ledgers/object?signature=secret',
      })),
      isRepositoryError('invalid_segment'),
    );
    await assert.rejects(
      () => repository.create(manifest({
        segmentId: randomUUID(),
        sourceKeyBounds: { lowerInclusive: 500n, upperExclusive: 500n },
      })),
      isRepositoryError('invalid_segment'),
    );
  });

  test('CAS conflicts and duplicate transitions fail stably', async () => {
    const created = await repository.create(manifest());
    const sealed = await repository.transition({
      segmentId: created.segmentId,
      expectedState: 'open',
      expectedRevision: 1n,
      targetState: 'sealed',
      evidence: { manifest: 'captured' },
    });
    assert.equal(sealed.stateRevision, 2n);

    const duplicate = {
      segmentId: created.segmentId,
      expectedState: 'open' as const,
      expectedRevision: 1n,
      targetState: 'sealed' as const,
      evidence: { manifest: 'captured' },
    };
    await assert.rejects(() => repository.transition(duplicate), isRepositoryError('cas_conflict'));
    await assert.rejects(
      () => repository.transition({ ...duplicate, targetState: 'verified' }),
      isRepositoryError('illegal_transition'),
    );
  });

  test('legal hold blocks delete states until separately cleared by CAS', async () => {
    let segment = await repository.create(manifest());
    for (const targetState of STATES.slice(1, 6)) {
      segment = await repository.transition({
        segmentId: segment.segmentId,
        expectedState: segment.state,
        expectedRevision: segment.stateRevision,
        targetState,
        evidence: { changeId: targetState },
      });
    }
    assert.equal(segment.state, 'detached');

    segment = await repository.setLegalHold({
      segmentId: segment.segmentId,
      expectedState: 'detached',
      expectedRevision: segment.stateRevision,
      legalHold: true,
    });
    await assert.rejects(
      () => repository.transition({
        segmentId: segment.segmentId,
        expectedState: 'detached',
        expectedRevision: segment.stateRevision,
        targetState: 'deletable',
        evidence: { authorization: 'must-not-apply' },
      }),
      isRepositoryError('legal_hold_blocked'),
    );

    segment = await repository.setLegalHold({
      segmentId: segment.segmentId,
      expectedState: 'detached',
      expectedRevision: segment.stateRevision,
      legalHold: false,
    });
    segment = await repository.transition({
      segmentId: segment.segmentId,
      expectedState: 'detached',
      expectedRevision: segment.stateRevision,
      targetState: 'deletable',
      evidence: { externalAuthorization: 'change-123' },
    });
    assert.equal(segment.state, 'deletable');
  });

  test('down/up smoke removes and restores only the control-plane relation', async () => {
    const smoke = await createIsolatedPostgresRuntime('ledger_archive_down_up');
    try {
      const migrator = createMigrator(smoke.runtime.db, 'migrations', smoke.schema);
      const before = await migrator.migrateTo('202609280800_auth_session_token_lookup_index');
      if (before.error) throw before.error;
      assert.equal(await relationPresent(smoke, 'ledger_archive_segments'), false);

      const up = await migrator.migrateTo('202610010100_ledger_archive_segments');
      if (up.error) throw up.error;
      assert.equal(await relationPresent(smoke, 'ledger_archive_segments'), true);

      const down = await migrator.migrateTo('202609280800_auth_session_token_lookup_index');
      if (down.error) throw down.error;
      assert.equal(await relationPresent(smoke, 'ledger_archive_segments'), false);

      const forward = await migrator.migrateTo('202610010100_ledger_archive_segments');
      if (forward.error) throw forward.error;
      assert.equal(await relationPresent(smoke, 'ledger_archive_segments'), true);
    } finally {
      await smoke.close();
    }
  }, 120_000);
});

async function relationPresent(runtime: IsolatedPostgresRuntime, relation: string): Promise<boolean> {
  const result = await runtime.runtime.pool.query<{ present: boolean }>(
    'select to_regclass($1) is not null present',
    [relation],
  );
  return result.rows[0]?.present === true;
}
