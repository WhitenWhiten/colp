import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresFaviconGcRepository } from '../../../src/infrastructure/collections/favicon-gc-postgres.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLECTION_ID = randomUUID();
const ROOT_ID = randomUUID();

describeWithPostgres('favicon restore reference GC (FO-C-03)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_restore_gc', { maxConnections: 5 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
           ($1,'collection'), ($2,'node')`,
        [COLLECTION_ID, ROOT_ID],
      );
      await client.query(`insert into accounts(id, subject_id, status)
        values ($1, 'fo-c03-owner', 'active')`, [ACCOUNT_ID]);
      await client.query(`insert into collections(
        id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
        root_node_id, root_node_is_root, resource_revision, content_revision,
        policy_revision, commit_ordinal)
        values ($1, 'fo-c03-owner', 'FO-C-03', 'bookmarks', 'public', 'fo-c03',
          current_timestamp, $2, true, 'r1', 'c1', 'p1', 1)`,
      [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(
        id, collection_id, parent_id, kind, is_root, title, url, position_token,
        resource_revision, children_revision)
        values ($1, $2, null, 'folder', true, 'Root', null, null, 'r1', 'ch1')`,
      [ROOT_ID, COLLECTION_ID]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => isolated?.close());

  /** Seed one bookmark node with a live binding and a force-window restore snapshot. */
  async function seedScenario(): Promise<{ readonly original: string; readonly nodeId: string }> {
    const nodeId = randomUUID();
    const bound = randomUUID();
    const original = randomUUID();
    const position = `pb-${randomUUID().replaceAll('-', '')}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id, resource_type)
        values ($1, 'node')`, [nodeId]);
      await client.query(`insert into nodes(
        id, collection_id, parent_id, kind, is_root, title, url, position_token,
        resource_revision, children_revision)
        values ($1, $2, $3, 'bookmark', false, 'bookmark', 'https://example.test/b',
          $4, 'r2', 'ch-b')`, [nodeId, COLLECTION_ID, ROOT_ID, position]);
      await client.query(`insert into bookmark_icons(
        node_id, collection_id, object_id, content_type, byte_size, digest_sha256,
        created_at, updated_at)
        values ($1, $2, $3, 'image/png', 10, decode(repeat('ab', 32), 'hex'),
          current_timestamp, current_timestamp)`, [nodeId, COLLECTION_ID, bound]);
      await client.query(`insert into favicon_source_restores(
        node_id, collection_id, account_id, original_source_mode,
        original_object_id, original_content_type, original_byte_size,
        original_digest_sha256, source_revision, created_at, updated_at)
        values ($1, $2, $3, 'online', $4, 'image/png', 9,
          decode(repeat('cd', 32), 'hex'), 1, current_timestamp, current_timestamp)`,
      [nodeId, COLLECTION_ID, ACCOUNT_ID, original]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { original, nodeId };
  }

  async function pendingFor(objectId: string): Promise<Array<{ deletable_at: Date }>> {
    const result = await isolated.runtime.pool.query<{ deletable_at: Date }>(
      `select deletable_at from favicon_pending_deletions where object_id = $1`, [objectId]);
    return result.rows;
  }

  test('node tombstone inside a force window releases the restore row and ledges the original', async () => {
    const { original, nodeId } = await seedScenario();
    assert.equal((await pendingFor(original)).length, 0);
    await isolated.runtime.pool.query(
      `update nodes set deleted_at = current_timestamp, updated_at = current_timestamp where id = $1`,
      [nodeId]);
    const restoreRows = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_source_restores where node_id = $1`, [nodeId]);
    assert.equal(restoreRows.rows[0]!.n, 0, 'tombstone must drop the force-window restore row');
    const pending = await pendingFor(original);
    assert.equal(pending.length, 1, 'the tombstoned restore original must enter the GC ledger');
    assert.ok(pending[0]!.deletable_at.getTime() > Date.now(), 'one-year retention window');
  });

  test('direct restore-row deletion (consume path) ledges an unbound original that the GC can reclaim', async () => {
    const { original, nodeId } = await seedScenario();
    await isolated.runtime.pool.query(
      `delete from favicon_source_restores where node_id = $1`, [nodeId]);
    assert.equal((await pendingFor(original)).length, 1, 'consumed restore original must be ledged');
    const gc = createPostgresFaviconGcRepository(isolated.runtime.pool);
    assert.equal(await gc.repository.isObjectReferenced(original), false,
      'no binding references the released original — reclaimable');
  });

  test('an original that was re-bound stays protected, then becomes reclaimable once released', async () => {
    const { original, nodeId } = await seedScenario();
    const rebound = randomUUID();
    await isolated.runtime.pool.query(`update bookmark_icons set object_id = $1 where node_id = $2`,
      [rebound, nodeId]);
    const gc = createPostgresFaviconGcRepository(isolated.runtime.pool);
    // Restore reference semantics: the original is a hard reference while the
    // restore row exists, even though the live binding has moved on.
    assert.equal(await gc.repository.isObjectReferenced(original), true);
    await isolated.runtime.pool.query(
      `delete from favicon_source_restores where node_id = $1`, [nodeId]);
    assert.equal((await pendingFor(original)).length, 1, 'ledged on release');
    assert.equal(await gc.repository.isObjectReferenced(original), false,
      'after release (restore consumed) and no binding, the original is reclaimable');
  });

  test('account deletion cascades the restore row and ledges the original', async () => {
    const { original } = await seedScenario();
    assert.equal((await pendingFor(original)).length, 0);
    await isolated.runtime.pool.query(`delete from accounts where id = $1`, [ACCOUNT_ID]);
    assert.equal((await pendingFor(original)).length, 1,
      'the account-deletion cascade must release the restore-referenced original');
  });
});