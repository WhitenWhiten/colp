import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCollectionExportReadPort } from '../../../src/infrastructure/collections/collection-export-postgres.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * The unit suite for the export CLI doubles the Kysely builders, so the real
 * tenancy and soft-delete predicates never reach PostgreSQL. This suite runs
 * the same read port and the CLI owner lookup against a migrated database with
 * two owners, a soft-deleted account, live rows and tombstones.
 */
const state = vi.hoisted(() => ({ databaseUrl: '' }));

vi.mock('../../../src/bootstrap/self-hosted-preset.js', () => ({
  applySelfHostedPreset: () => undefined,
}));

vi.mock('../../../src/bootstrap/config.js', () => ({
  loadConfig: () => ({
    databaseUrl: state.databaseUrl,
    database: { connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000 },
    nodeEnv: 'test',
    databaseSsl: undefined,
    publication: { origin: 'https://colp.example.test' },
  }),
}));

const { ExportCliError, exportOwnedCollections } = await import('../../../src/cli/export.js');

interface CatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

interface Catalog {
  readonly collections: readonly CatalogEntry[];
}

interface SnapshotDocument {
  readonly collection: { readonly id: string };
  readonly nodes: ReadonlyArray<{ readonly id: string }>;
}

describeWithPostgres('collection export read port tenancy (PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  const directories: string[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collection_export_read', { maxConnections: 6 });
    state.databaseUrl = isolated.databaseUrl;
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixture();
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  async function seedFixture(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into accounts (id, subject_id, status) values
        ('acct-a', 'subject-a', 'active'),
        ('acct-b', 'subject-b', 'active'),
        ('acct-deleted', 'subject-deleted', 'deleted')`);
      await client.query(`update accounts set deleted_at = now() where id = 'acct-deleted'`);
      await client.query(`insert into auth_users (id, name, email, "emailVerified", username) values
        ('user-a', 'Alice', 'alice@example.test', true, 'alice'),
        ('user-b', 'Bob', 'bob@example.test', true, 'bob'),
        ('user-deleted', 'Deleted', 'deleted@example.test', true, 'deleted'),
        ('user-unmapped', 'Unmapped', 'unmapped@example.test', true, 'unmapped')`);
      await client.query(`insert into auth_user_account_map (auth_user_id, account_id) values
        ('user-a', 'acct-a'),
        ('user-b', 'acct-b'),
        ('user-deleted', 'acct-deleted')`);
      await client.query(`insert into resource_id_ledger (resource_id, resource_type) values
        ('col-a-live', 'collection'),
        ('col-a-deleted', 'collection'),
        ('col-b-live', 'collection'),
        ('col-b-deleted', 'collection'),
        ('node-a-live-root', 'node'),
        ('node-a-live-bookmark', 'node'),
        ('node-a-deleted-bookmark', 'node'),
        ('node-a-deleted-root', 'node'),
        ('node-b-live-root', 'node'),
        ('node-b-live-bookmark', 'node'),
        ('node-b-deleted-root', 'node')`);
      await client.query(`insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, commit_ordinal)
        values
        ('col-a-live', 'subject-a', 'Alpha live', 'bookmarks', 'private', 'node-a-live-root',
         'rev-a-live', 'content-a-live', 'policy-r1', 1),
        ('col-a-deleted', 'subject-a', 'Alpha deleted', 'bookmarks', 'private', 'node-a-deleted-root',
         'rev-a-deleted', 'content-a-deleted', 'policy-r1', 2),
        ('col-b-live', 'subject-b', 'Beta live', 'bookmarks', 'private', 'node-b-live-root',
         'rev-b-live', 'content-b-live', 'policy-r1', 1),
        ('col-b-deleted', 'subject-b', 'Beta deleted', 'bookmarks', 'private', 'node-b-deleted-root',
         'rev-b-deleted', 'content-b-deleted', 'policy-r1', 2)`);
      await client.query(`insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, tags, visibility,
         position_token, resource_revision, children_revision)
        values
        ('node-a-live-root', 'col-a-live', null, 'folder', true, 'Alpha live', null, null, 'inherit',
         null, 'rev-a-root', 'rev-a-root-children'),
        ('node-a-live-bookmark', 'col-a-live', 'node-a-live-root', 'bookmark', false,
         'Alpha bookmark', 'https://example.test/a-live', '["alpha"]'::jsonb, 'inherit',
         'a0', 'rev-a-bookmark', 'rev-a-bookmark-children'),
        ('node-a-deleted-bookmark', 'col-a-live', 'node-a-live-root', 'bookmark', false,
         'Alpha deleted bookmark', 'https://example.test/a-deleted', '[]'::jsonb, 'inherit',
         'a1', 'rev-a-deleted-bookmark', 'rev-a-deleted-bookmark-children'),
        ('node-a-deleted-root', 'col-a-deleted', null, 'folder', true, 'Alpha deleted', null, null,
         'inherit', null, 'rev-a-deleted-root', 'rev-a-deleted-root-children'),
        ('node-b-live-root', 'col-b-live', null, 'folder', true, 'Beta live', null, null, 'inherit',
         null, 'rev-b-root', 'rev-b-root-children'),
        ('node-b-live-bookmark', 'col-b-live', 'node-b-live-root', 'bookmark', false,
         'Beta bookmark', 'https://example.test/b-live', '[]'::jsonb, 'inherit',
         'b0', 'rev-b-bookmark', 'rev-b-bookmark-children'),
        ('node-b-deleted-root', 'col-b-deleted', null, 'folder', true, 'Beta deleted', null, null,
         'inherit', null, 'rev-b-deleted-root', 'rev-b-deleted-root-children')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Tombstones are applied after the live rows commit: the deferred
    // root-lifecycle trigger replays the original INSERT events too, so a
    // collection cannot be inserted and soft-deleted in the same transaction.
    const tombstones = await isolated.runtime.pool.connect();
    try {
      await tombstones.query('begin');
      await tombstones.query(`update nodes set deleted_at = now(), deleted_commit_ordinal = 2
        where id = 'node-a-deleted-bookmark'`);
      await tombstones.query(`update nodes set deleted_at = now(), deleted_commit_ordinal = 2
        where id = 'node-a-deleted-root'`);
      await tombstones.query(`update collections set deleted_at = now()
        where id = 'col-a-deleted'`);
      await tombstones.query(`update nodes set deleted_at = now(), deleted_commit_ordinal = 2
        where id = 'node-b-deleted-root'`);
      await tombstones.query(`update collections set deleted_at = now()
        where id = 'col-b-deleted'`);
      await tombstones.query('commit');
    } catch (error) {
      await tombstones.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      tombstones.release();
    }
  }

  test('the read port scopes collections to the owner subject and hides tombstones', async () => {
    const reads = createPostgresCollectionExportReadPort(isolated.runtime.db);
    assert.deepEqual(await reads.listOwnedIds('subject-a'), ['col-a-live']);
    assert.deepEqual(await reads.listOwnedIds('subject-b'), ['col-b-live']);
    assert.deepEqual(await reads.listOwnedIds('subject-deleted'), []);

    // Owner A cannot read B's live collection and neither owner can read the
    // other's (or their own) soft-deleted collection.
    assert.equal(await reads.loadForPrincipal({ collectionId: 'col-b-live', subjectId: 'subject-a' }), null);
    assert.equal(await reads.loadForPrincipal({ collectionId: 'col-a-live', subjectId: 'subject-b' }), null);
    assert.equal(await reads.loadForPrincipal({ collectionId: 'col-a-deleted', subjectId: 'subject-a' }), null);
    assert.equal(await reads.loadForPrincipal({ collectionId: 'col-b-deleted', subjectId: 'subject-b' }), null);

    const source = await reads.loadForPrincipal({ collectionId: 'col-a-live', subjectId: 'subject-a' });
    assert.ok(source !== null, 'owner A loads its own live collection');
    assert.equal(source.id, 'col-a-live');
    assert.equal(source.access, 'owner');
    assert.deepEqual(source.nodes.map((node) => node.id).sort(),
      ['node-a-live-bookmark', 'node-a-live-root']);
    assert.equal(source.nodes.some((node) => node.id === 'node-a-deleted-bookmark'), false,
      'soft-deleted nodes are not exported');
    assert.equal(source.nodes.some((node) => node.id.startsWith('node-b-')), false,
      "another owner's nodes never leak into the snapshot");
  });

  test('the export CLI resolves auth_users -> auth_user_account_map -> accounts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'colp-export-postgres-'));
    directories.push(directory);

    await exportOwnedCollections({ username: 'alice', outDir: directory });

    const catalog = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as Catalog;
    assert.deepEqual(catalog.collections.map((entry) => entry.id), ['col-a-live'],
      'only owner A live collections are exported for alice');
    assert.deepEqual(catalog.collections.map((entry) => entry.slug), ['alpha-live']);
    const files = await readdir(directory);
    assert.deepEqual(files.sort(),
      ['alpha-live.html', 'alpha-live.json', 'automations.json', 'index.json']);

    const snapshot = JSON.parse(
      await readFile(join(directory, 'alpha-live.json'), 'utf8'),
    ) as SnapshotDocument;
    assert.equal(snapshot.collection.id, 'col-a-live');
    assert.deepEqual(snapshot.nodes.map((node) => node.id).sort(),
      ['node-a-live-bookmark', 'node-a-live-root']);
  });

  test('the owner lookup rejects a deleted account and an unmapped auth user', async () => {
    const deletedDirectory = join(tmpdir(), `colp-export-deleted-${process.pid}-${Date.now()}`);
    await assert.rejects(
      () => exportOwnedCollections({ username: 'deleted', outDir: deletedDirectory }),
      (error: unknown) => {
        assert.ok(error instanceof ExportCliError, `expected ExportCliError, got ${String(error)}`);
        assert.equal(error.code, 3);
        assert.match(error.message, /unknown user/u);
        return true;
      },
    );
    await assert.rejects(access(deletedDirectory), { code: 'ENOENT' },
      'the CLI must fail before creating an output directory');

    const unmappedDirectory = join(tmpdir(), `colp-export-unmapped-${process.pid}-${Date.now()}`);
    await assert.rejects(
      () => exportOwnedCollections({ username: 'unmapped', outDir: unmappedDirectory }),
      (error: unknown) => {
        assert.ok(error instanceof ExportCliError, `expected ExportCliError, got ${String(error)}`);
        assert.equal(error.code, 1);
        assert.match(error.message, /account mapping/u);
        return true;
      },
    );
    await assert.rejects(access(unmappedDirectory), { code: 'ENOENT' });
  });
});
