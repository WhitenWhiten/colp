import { createHistoricalMigrator } from '../../support/historical-migrations.js';
/**
 * P4A-I14 cleanup retention migration evidence against isolated PostgreSQL.
 *
 * - the expand migration ships `retired_at` / `orphaned_at` on
 *   `blob_generations` and the bounded retention index;
 * - the production transition writers stamp the DB-clock timestamps
 *   (activateReplacement -> retired_at, late-complete -> orphaned_at);
 * - the retention-expired claim predicate uses the DATABASE clock with an
 *   inclusive boundary (a generation exactly at its deadline IS eligible) and
 *   never treats a null timestamp as expired;
 * - upgrade from the previous stable head and down/up round trip.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, createPostgresAttachmentsPorts, createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  identityFor,
  i07Uow,
  makeBucket,
  sha256Hex,
  uuidFor,
  keyFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const PREVIOUS_HEAD = '202608080200_phase4a_i13_finalize_binding';
const I14_MIGRATION = '202608080300_phase4a_i14_cleanup_retention';
const RETENTION_COLUMNS = ['retired_at', 'orphaned_at'];

const ports = createPostgresAttachmentsPorts();

/** Production-shaped two-generation blob: old active -> retired, next active. */
async function seedBlobWithRetired(
  uow: ReturnType<typeof i07Uow>,
  old: ReturnType<typeof identityFor>,
  next: ReturnType<typeof identityFor>,
): Promise<void> {
  await uow.execute(async (tx) => {
    await ports.allocate(tx, {
      blobId: old.blobId, intentId: old.intentId, generationId: old.generationId,
      principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
      bucket: makeBucket(), key: old.key, keyFingerprint: sha256Hex(old.key),
      expectedSize: 7, expectedSha256: 'a'.repeat(64), mediaHint: 'application/octet-stream',
      policyRevision: 'p1', idempotencyKey: `idem-${old.intentId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ports.complete(tx, {
      intentId: old.intentId, generationId: old.generationId, blobId: old.blobId,
      observedEtag: `"etag-${old.generationId}"`, observedSize: 7,
      observedContentType: 'application/octet-stream', observedMetadata: {},
    });
    await ports.allocate(tx, {
      blobId: old.blobId, intentId: next.intentId, generationId: next.generationId,
      principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
      bucket: makeBucket(), key: next.key, keyFingerprint: sha256Hex(next.key),
      expectedSize: 7, expectedSha256: 'b'.repeat(64), mediaHint: 'application/octet-stream',
      policyRevision: 'p1', idempotencyKey: `idem-${next.intentId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ports.complete(tx, {
      intentId: next.intentId, generationId: next.generationId, blobId: old.blobId,
      observedEtag: `"etag-${next.generationId}"`, observedSize: 7,
      observedContentType: 'application/octet-stream', observedMetadata: {},
    });
    await ports.activateReplacement(tx, {
      blobId: old.blobId, expectedActiveGenerationId: old.generationId, newGenerationId: next.generationId,
    });
  });
}


describeWithPostgres('P4A-I14 cleanup retention migration', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i14_migration');
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the expand migration ships the retention columns and the bounded index', async () => {
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'blob_generations'
    `.execute(isolated.runtime.db);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of RETENTION_COLUMNS) {
      assert.ok(names.has(column), `missing retention column ${column}`);
    }
    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where schemaname = current_schema() and tablename = 'blob_generations'
    `.execute(isolated.runtime.db);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    assert.ok(indexNames.has('blob_generations_cleanup_retention_idx'), 'the retention candidate index must exist');
  });

  test('activateReplacement stamps retired_at and late-complete stamps orphaned_at (DB clock)', async () => {
    const old = identityFor(1);
    const next = identityFor(2);
    const uow = i07Uow(isolated.runtime);
    await uow.execute(async (tx) => {
      await ports.allocate(tx, {
        blobId: old.blobId, intentId: old.intentId, generationId: old.generationId,
        principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
        bucket: makeBucket(), key: old.key, keyFingerprint: sha256Hex(old.key),
        expectedSize: 7, expectedSha256: 'a'.repeat(64), mediaHint: 'application/octet-stream',
        policyRevision: 'p1', idempotencyKey: `idem-${old.intentId}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await ports.complete(tx, {
        intentId: old.intentId, generationId: old.generationId, blobId: old.blobId,
        observedEtag: `"etag-old"`, observedSize: 7, observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      await ports.allocate(tx, {
        blobId: old.blobId, intentId: next.intentId, generationId: next.generationId,
        principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
        bucket: makeBucket(), key: next.key, keyFingerprint: sha256Hex(next.key),
        expectedSize: 7, expectedSha256: 'b'.repeat(64), mediaHint: 'application/octet-stream',
        policyRevision: 'p1', idempotencyKey: `idem-${next.intentId}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await ports.complete(tx, {
        intentId: next.intentId, generationId: next.generationId, blobId: old.blobId,
        observedEtag: `"etag-next"`, observedSize: 7, observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      await ports.activateReplacement(tx, {
        blobId: old.blobId, expectedActiveGenerationId: old.generationId, newGenerationId: next.generationId,
      });
    });
    const retiredRow = await sql<{ retired_at: Date | null }>`
      select retired_at from blob_generations where generation_id = ${old.generationId}
    `.execute(isolated.runtime.db);
    assert.ok(retiredRow.rows[0]?.retired_at instanceof Date, 'the retired generation carries a DB-clock retired_at');

    // Late-complete of an expired intent transitions an allocated generation to
    // orphaned with a DB-clock orphaned_at.
    const orphan = identityFor(3);
    await uow.execute(async (tx) => {
      await ports.allocate(tx, {
        blobId: orphan.blobId, intentId: orphan.intentId, generationId: orphan.generationId,
        principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
        bucket: makeBucket(), key: orphan.key, keyFingerprint: sha256Hex(orphan.key),
        expectedSize: 7, expectedSha256: 'c'.repeat(64), mediaHint: 'application/octet-stream',
        policyRevision: 'p1', idempotencyKey: `idem-${orphan.intentId}`,
        expiresAt: new Date(Date.now() - 3_600_000),
      });
      const completed = await ports.complete(tx, {
        intentId: orphan.intentId, generationId: orphan.generationId, blobId: orphan.blobId,
        observedEtag: `"etag-orphan"`, observedSize: 7, observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      assert.equal(completed.outcome, 'late_rejected');
    });
    const orphanRow = await sql<{ generation_state: string; orphaned_at: Date | null }>`
      select generation_state, orphaned_at from blob_generations where generation_id = ${orphan.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(orphanRow.rows[0]!.generation_state, 'orphaned');
    assert.ok(orphanRow.rows[0]!.orphaned_at instanceof Date, 'the orphaned generation carries a DB-clock orphaned_at');
  });

  test('the retention-expired claim predicate uses the DB clock with an inclusive boundary', async () => {
    const uow = i07Uow(isolated.runtime);
    const specs: Array<{ id: ReturnType<typeof identityFor>; next: ReturnType<typeof identityFor>; backdate: string }> = [
      { id: identityFor(4), next: identityFor(5), backdate: "interval '2 days'" },
      { id: identityFor(6), next: identityFor(7), backdate: "interval '1 day'" },
      { id: identityFor(8), next: identityFor(9), backdate: "interval '23 hours'" },
    ];
    for (const spec of specs) {
      await seedBlobWithRetired(uow, spec.id, spec.next);
      await sql`
        update blob_generations set retired_at = now() - ${sql.raw(spec.backdate)}
        where generation_id = ${spec.id.generationId}
      `.execute(isolated.runtime.db);
    }

    const claimed = await uow.execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'cleaner', leaseTtlSeconds: 60, limit: 10, retiredRetentionDays: 1,
    }));
    assert.equal(claimed.outcome, 'batch');
    if (claimed.outcome !== 'batch') return;
    const ids = claimed.claims.map((claim) => claim.generationId);
    assert.ok(ids.includes(specs[0]!.id.generationId), 'past-deadline is eligible');
    assert.ok(ids.includes(specs[1]!.id.generationId), 'exactly-at-deadline is eligible (inclusive DB-clock boundary)');
    assert.ok(!ids.includes(specs[2]!.id.generationId), 'before the deadline is retained');
  });
  test('upgrades from the previous stable head and round-trips down and up', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase4a_i14_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202608080300_phase4a_i14_cleanup_retention');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      const columnAbsent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_generations'
            and column_name = 'retired_at'`,
      );
      assert.equal(columnAbsent.rows[0]?.present, false, 'retirement columns must not exist before the I14 migration');

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const applied = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [I14_MIGRATION],
      );
      assert.equal(applied.rows.length, 1, 'the I14 migration must be recorded as applied');

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      const columnGone = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_generations'
            and column_name = 'orphaned_at'`,
      );
      assert.equal(columnGone.rows[0]?.present, false, 'down must remove the retention columns cleanly');

      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      const columnBack = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_generations'
            and column_name = 'retired_at'`,
      );
      assert.equal(columnBack.rows[0]?.present, true, 'up again must restore the retention columns');
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});
