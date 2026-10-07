import { createHistoricalMigrator } from '../../support/historical-migrations.js';
/**
 * P4A-P02 Attachment metadata migration evidence against isolated PostgreSQL.
 *
 * - the expand migration ships the `attachments` owner-private metadata table
 *   with its named constraints and the blob-binding trigger;
 * - direct SQL negatives prove the constraints are real (SQLSTATE + named
 *   constraint): an unsanitized filename is rejected, the metadata
 *   attachment_id MUST equal the committed blob_records binding on an
 *   attached_private blob, a second Attachment on the same blob is a
 *   permanent identity violation, a reissued ledger id is impossible, and the
 *   retirement/deletion facts are terminal;
 * - empty-database apply, upgrade from the previous stable head, and a
 *   down/up round trip all succeed.
 *
 * Anti-false-positive: the target row is only ever INSERTED through fixture
 * SQL that establishes legal preconditions (ledger + collection + bound blob);
 * every NEGATIVE below breaks exactly one constraint of that legal state.
 * The production Canonical Mutation write path is exercised in the canonical
 * and races suites; this file proves the durable backstop constraints.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { sha256Hex, uuidFor } from '../../support/phase4a-i07-test-helpers.js';

const PREVIOUS_HEAD = '202608080400_phase4a_i15_operations';
const P02_MIGRATION = '202608080500_phase4a_p02_attachment_metadata';

const ATTACHMENTS_COLUMNS = [
  'attachment_id',
  'blob_id',
  'collection_id',
  'owner_subject_id',
  'sanitized_filename',
  'media_type',
  'size',
  'logical_state',
  'attached_at',
  'retired_at',
  'deleted_at',
  'created_at',
  'updated_at',
];

const ATTACHMENTS_CONSTRAINTS = [
  'attachments_logical_state_check',
  'attachments_blob_id_unique',
  'attachments_attachment_id_fk',
  'attachments_blob_id_fk',
  'attachments_collection_id_fk',
  'attachments_sanitized_filename_check',
  'attachments_size_check',
  'attachments_retirement_facts_check',
  'attachments_deletion_facts_check',
  'attachments_active_state_facts_check',
];

async function expectSqlState(
  runtime: IsolatedPostgresRuntime,
  statement: (pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let failure: { code?: string; constraint?: string } | undefined;
  try {
    await statement(runtime.runtime.pool);
  } catch (error) {
    failure = error as { code?: string; constraint?: string };
  }
  assert.ok(failure, 'the statement must be rejected by the database');
  assert.equal(failure.code, code, `expected SQLSTATE ${code}`);
  if (constraint !== undefined) assert.equal(failure.constraint, constraint, 'expected named constraint');
}

interface BoundAttachmentFixture {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly generationId: string;
  readonly collectionId: string;
}

/**
 * Establishes a LEGAL pre-state for the constraint negatives: ledger rows
 * (attachment + collection + root), a Collection with its root node, and an
 * `attached_private` blob carrying the full I13 binding facts for
 * `attachmentId`. Only then can the tests break exactly one constraint.
 * `reserveBindingInLedger: false` builds the blob binding WITHOUT a ledger
 * row (an N-1/integrity state the I13 columns alone cannot prevent), so the
 * attachments FK to the ledger is the durable backstop.
 */
async function seedBoundAttachmentFixture(
  runtime: IsolatedPostgresRuntime,
  attachmentId: string,
  blobId: string,
  generationId: string,
  collectionId: string,
  options: { readonly reserveBindingInLedger?: boolean } = {},
): Promise<void> {
  // The collections root FK is DEFERRABLE INITIALLY DEFERRED, so the whole
  // legal pre-state must be established inside ONE transaction (autocommit
  // statements would commit the collection before its root node exists).
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    const rootId = `${collectionId}-root`;
    const key = `key-${generationId}`;
    const fingerprint = sha256Hex(key);
    if (options.reserveBindingInLedger !== false) {
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
           ($1, 'attachment'), ($2, 'collection'), ($3, 'node')`,
        [attachmentId, collectionId, rootId],
      );
    } else {
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
           ($1, 'collection'), ($2, 'node')`,
        [collectionId, rootId],
      );
    }
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
          resource_revision, content_revision, policy_revision, publication_slug,
          published_at, allow_search_indexing, created_at, updated_at)
       values ($1, 'subject-owner', 'p02 migration collection', 'p02 summary', 'bookmarks',
          'private', $2, 'r1', 'c1', 'p1', null, null, false, now(), now())`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
          visibility, position_token, resource_revision, children_revision, created_at, updated_at)
       values ($1, $2, null, 'folder', true, 'Root', null, null, '[]'::jsonb,
          'inherit', null, 'r1', 'ch1', now(), now())`,
      [rootId, collectionId],
    );
    await client.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
       values ($1, $2, $3, $4, 'allocate')`,
      [generationId, key, fingerprint, blobId],
    );
    await client.query(
      `insert into blob_records
         (blob_id, owner_subject_id, logical_state, verified_size, verified_sha256,
          media_type, verification_policy_version)
       values ($1, 'subject-owner', 'stored_private', 7, $2, 'image/png', 'policy-v1')`,
      [blobId, 'a'.repeat(64)],
    );
    await client.query(
      `insert into blob_generations
         (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
       values ($1, $2, 'known-p02', $3, $4, 'active')`,
      [generationId, blobId, key, fingerprint],
    );
    await client.query(
      `update blob_records set current_generation_id = $2 where blob_id = $1`,
      [blobId, generationId],
    );
    // The terminal binding is written only AFTER the current pointer exists
    // (mirrors the finalize handoff ordering; the generation-snapshot CHECK
    // requires current_generation_id to be set first).
    await client.query(
      `update blob_records
          set logical_state = 'attached_private',
              attachment_binding_id = $2,
              attached_at = now(),
              attachment_binding_generation_id = $3,
              attachment_binding_etag = '"etag-1"',
              attachment_binding_policy_version = 'policy-v1'
        where blob_id = $1`,
      [blobId, attachmentId, generationId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The legal metadata insert for the fixture (all constraint negatives start from it). */
function metadataInsert(
  attachmentId: string,
  blobId: string,
  collectionId: string,
  filename: string | null,
): string {
  return `insert into attachments
    (attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
     media_type, size, logical_state, attached_at)
    values ('${attachmentId}', '${blobId}', '${collectionId}', 'subject-owner',
      ${filename === null ? 'null' : `'${filename}'`}, 'image/png', 7, 'attached_private', now())`;
}

describeWithPostgres('P4A-P02 Attachment metadata migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4a_p02_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('the expand migration ships the attachments table, named constraints and binding trigger on an empty database', async () => {
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'attachments'
    `.execute(isolated.runtime.db);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of ATTACHMENTS_COLUMNS) {
      assert.ok(names.has(column), `missing attachment metadata column ${column}`);
    }
    assert.ok(!names.has('key') && !names.has('key_fingerprint') && !names.has('bucket')
      && !names.has('url') && !names.has('credential'),
    'the Attachment row must never carry a physical key, URL or credential column');

    const constraints = await sql<{ conname: string }>`
      select conname from pg_constraint
      where connamespace = current_schema()::regnamespace
        and conname = any(${ATTACHMENTS_CONSTRAINTS})
    `.execute(isolated.runtime.db);
    assert.equal(constraints.rows.length, ATTACHMENTS_CONSTRAINTS.length,
      'all named attachment constraints must exist');

    const triggers = await sql<{ tgname: string }>`
      select tgname from pg_trigger
      where tgrelid = 'attachments'::regclass
        and tgname = 'attachments_blob_binding'
        and not tgisinternal
    `.execute(isolated.runtime.db);
    assert.equal(triggers.rows.length, 1, 'the blob-binding trigger must exist');
  });

  test('direct SQL negative: an unsanitized filename (path separator) is rejected with the named CHECK', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-unsanitized-${uuidFor(7001)}`,
      blobId: uuidFor(7101),
      generationId: uuidFor(7201),
      collectionId: `p02-mig-col-${uuidFor(7301)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'unsafe/../name.png')),
      '23514',
      'attachments_sanitized_filename_check',
    );
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'unsafe\\name.png')),
      '23514',
      'attachments_sanitized_filename_check',
    );
  });

  test('direct SQL negative: a control character in the filename is rejected with the named CHECK', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-ctrl-${uuidFor(7002)}`,
      blobId: uuidFor(7102),
      generationId: uuidFor(7202),
      collectionId: `p02-mig-col-${uuidFor(7302)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    // A literal tab is legal in SQL text (a raw NUL byte is not accepted by
    // the PostgreSQL lexer), and the sanitized-filename CHECK rejects it.
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'name\t.png')),
      '23514',
      'attachments_sanitized_filename_check',
    );
  });

  test('direct SQL negative: the metadata attachment_id must equal the committed blob_records binding (trigger 23514)', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-binding-${uuidFor(7003)}`,
      blobId: uuidFor(7103),
      generationId: uuidFor(7203),
      collectionId: `p02-mig-col-${uuidFor(7303)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(`other-${fixture.attachmentId}`, fixture.blobId, fixture.collectionId, 'ok.png')),
      '23514',
    );
  });

  test('direct SQL negative: a second Attachment on the same blob is a permanent identity violation', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-dual-${uuidFor(7004)}`,
      blobId: uuidFor(7104),
      generationId: uuidFor(7204),
      collectionId: `p02-mig-col-${uuidFor(7304)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    await isolated.runtime.pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'ok.png'));
    // Same attachment id on the same blob -> primary key duplicate.
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'ok.png')),
      '23505',
      'attachments_pkey',
    );
    // A different attachment id on the same blob -> the binding trigger rejects it.
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(`other-${fixture.attachmentId}`, fixture.blobId, fixture.collectionId, 'ok.png')),
      '23514',
    );
  });

  test('direct SQL negative: an attachment id reissue is impossible (ledger immutability + FK)', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-reissue-${uuidFor(7005)}`,
      blobId: uuidFor(7105),
      generationId: uuidFor(7205),
      collectionId: `p02-mig-col-${uuidFor(7305)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    // Re-reserving the same id in the immutable ledger is a permanent violation.
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'attachment')`,
        [fixture.attachmentId],
      ),
      '23505',
      'resource_id_ledger_pkey',
    );
    // An attachment row whose id was never reserved cannot exist (FK to
    // ledger). The blob binding itself is built WITHOUT a ledger row so the
    // binding trigger passes and the ledger FK is the durable backstop.
    const unbound: BoundAttachmentFixture = {
      attachmentId: `never-reserved-${uuidFor(7007)}`,
      blobId: uuidFor(7107),
      generationId: uuidFor(7207),
      collectionId: `p02-mig-col-${uuidFor(7307)}`,
    };
    await seedBoundAttachmentFixture(isolated, unbound.attachmentId, unbound.blobId, unbound.generationId, unbound.collectionId, {
      reserveBindingInLedger: false,
    });
    await expectSqlState(
      isolated,
      async (pool) => pool.query(metadataInsert(unbound.attachmentId, unbound.blobId, unbound.collectionId, 'ok.png')),
      '23503',
      'attachments_attachment_id_fk',
    );
    // The ledger row is immutable: an update attempt is refused. The
    // pre-existing production trigger (phase1 `forbid_resource_id_ledger_mutation`)
    // raises a plain exception, so the SQLSTATE is P0001 (raise_exception) —
    // the P02 migration must not alter that production behavior.
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update resource_id_ledger set resource_type = 'other' where resource_id = $1`,
        [fixture.attachmentId],
      ),
      'P0001',
    );
  });

  test('direct SQL negative: retirement and deletion facts are terminal (named CHECKs)', async () => {
    const fixture: BoundAttachmentFixture = {
      attachmentId: `p02-mig-facts-${uuidFor(7006)}`,
      blobId: uuidFor(7106),
      generationId: uuidFor(7206),
      collectionId: `p02-mig-col-${uuidFor(7306)}`,
    };
    await seedBoundAttachmentFixture(isolated, fixture.attachmentId, fixture.blobId, fixture.generationId, fixture.collectionId);
    await isolated.runtime.pool.query(metadataInsert(fixture.attachmentId, fixture.blobId, fixture.collectionId, 'ok.png'));
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update attachments set logical_state = 'retired' where attachment_id = $1`,
        [fixture.attachmentId],
      ),
      '23514',
      'attachments_retirement_facts_check',
    );
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update attachments set logical_state = 'deleted' where attachment_id = $1`,
        [fixture.attachmentId],
      ),
      '23514',
      'attachments_deletion_facts_check',
    );
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update attachments set retired_at = now(), deleted_at = now() where attachment_id = $1`,
        [fixture.attachmentId],
      ),
      '23514',
      'attachments_active_state_facts_check',
    );
    // The legal terminal transitions commit.
    await isolated.runtime.pool.query(
      `update attachments set logical_state = 'retired', retired_at = now() where attachment_id = $1`,
      [fixture.attachmentId],
    );
    const row = await isolated.runtime.pool.query<{ logical_state: string; retired_at: Date | null }>(
      `select logical_state, retired_at from attachments where attachment_id = $1`,
      [fixture.attachmentId],
    );
    assert.equal(row.rows[0]?.logical_state, 'retired');
    assert.ok(row.rows[0]?.retired_at, 'retired_at must be recorded with the retirement fact');
  });

  test('upgrades from the previous stable head and round-trips down and up', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase4a_p02_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202608080500_phase4a_p02_attachment_metadata');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      const tableAbsent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.attachments') is not null as present`,
      );
      assert.equal(tableAbsent.rows[0]?.present, false, 'attachments must not exist at the previous head');

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const applied = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [P02_MIGRATION],
      );
      assert.equal(applied.rows.length, 1, 'the P02 migration must be recorded as applied');
      const tablePresent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.attachments') is not null as present`,
      );
      assert.equal(tablePresent.rows[0]?.present, true, 'attachments must exist after the upgrade');

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      const tableGone = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.attachments') is not null as present`,
      );
      assert.equal(tableGone.rows[0]?.present, false, 'down must remove the attachments table cleanly');
      const bindingColumnsIntact = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_records'
            and column_name = 'attachment_binding_id'`,
      );
      assert.equal(bindingColumnsIntact.rows[0]?.present, true,
        'down must NOT remove the I13 blob binding columns (they belong to the previous head)');

      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      const tableBack = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.attachments') is not null as present`,
      );
      assert.equal(tableBack.rows[0]?.present, true, 'up again must restore the attachments table');
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});
