import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationSnapshotCandidateStatement,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';

const instant = new Date('2026-07-24T00:00:00.000Z');

function runtimeWithRows(options: { missing?: boolean; failCandidates?: boolean } = {}): {
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>;
  calls: Array<{ sql: string; values?: readonly unknown[] }>;
  released: () => boolean;
} {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let didRelease = false;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')")) {
        return { rows: [{ isolation: 'repeatable read' }] };
      }
      if (sql.includes('from collections')) {
        return { rows: options.missing ? [] : [{
          id: 'collection-1', owner_subject_id: 'owner-1', kind: 'bookmarks', title: 'Collection',
          summary: null, visibility: 'public', publication_slug: 'collection-one', root_node_id: 'root-1',
          content_revision: 'content-1', policy_revision: 'policy-1', created_at: instant,
          updated_at: instant, deleted_at: null,
        }] };
      }
      if (sql.includes('or is_root')) {
        return { rows: [{
          id: 'root-1', collection_id: 'collection-1', parent_id: null, kind: 'folder', is_root: true,
          title: 'Root', url: null, description: null, tags: [], visibility: 'inherit', position_token: null,
          resource_revision: 'root-revision', created_at: instant, updated_at: instant,
        }] };
      }
      if (sql.includes('publication_locator_sha256_128')) {
        return { rows: [{ id: 'node-1', parent_id: 'root-1', position_token: 'A' }] };
      }
      if (sql.includes('row_number() over')) {
        if (options.failCandidates && sql.includes('order by')) throw new Error('candidate read failed');
        return { rows: [{
          id: 'node-1', collection_id: 'collection-1', parent_id: 'root-1', kind: 'bookmark', is_root: false,
          title: 'Node', url: 'https://example.test', description: null, tags: ['one'], visibility: 'inherit',
          position_token: 'A', resource_revision: 'node-revision', created_at: instant, updated_at: instant,
        }] };
      }
      return { rows: [] };
    },
    release() { didRelease = true; },
  };
  return {
    runtime: {
      pool: { async connect() { return client; } },
      cancelBackend: async () => true,
    } as unknown as Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
    calls,
    released: () => didRelease,
  };
}

test('loads detached collection, root, and limit+1 candidates in a fresh read-only repeatable-read transaction', async () => {
  const harness = runtimeWithRows();
  const adapter = createPostgresPublicationSnapshotReadPort(harness.runtime);
  const page = await adapter.loadPage({ collectionId: 'collection-1', limit: 200 });

  assert.equal(page.isolation, 'repeatable read');
  assert.equal(page.collection?.publicationSlug, 'collection-one');
  assert.equal(page.root?.id, 'root-1');
  const collectionCall = harness.calls.find((call) => call.sql.includes('from collections'));
  assert.match(collectionCall?.sql ?? '', /owner_account\.status = 'active'/u);
  assert.match(collectionCall?.sql ?? '', /owner_account\.deleted_at is null/u);
  assert.deepEqual(page.candidates.map((node) => node.id), ['node-1']);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.candidates[0]?.tags), true);
  assert.equal(harness.calls[0]?.sql, 'begin isolation level repeatable read read only');
  const nodeCall = harness.calls.find((call) => call.sql.includes('row_number() over'));
  assert.equal(nodeCall?.values?.at(-1), 201);
  assert.match(nodeCall?.sql ?? '', /deleted_at is null/u);
  assert.match(nodeCall?.sql ?? '', /collate "C"/u);
  assert.match(nodeCall?.sql ?? '', /order by coalesce\(parent_id/u);
  assert.equal(harness.calls.at(-1)?.sql, 'commit');
  assert.equal(harness.released(), true);
});

test('shared production statement binds the wide row, ancestor projection, C collation, and limit+1', () => {
  const statement = buildPublicationSnapshotCandidateStatement({
    collectionId: 'collection-1',
    limit: 500,
    after: { parentId: 'parent-1', position: 'B', nodeId: 'node-9' },
  });
  assert.deepEqual(statement.values, ['collection-1', 'parent-1', 'B', 'node-9', 501]);
  assert.match(statement.text, /select id, collection_id, parent_id, kind, is_root, title, url, description/u);
  assert.match(statement.text, /with recursive ancestors/u);
  assert.match(statement.text, /row_number\(\) over/u);
  assert.match(statement.text, /partition by coalesce\(parent_id/u);
  assert.match(statement.text, /as publication_position/u);
  assert.match(statement.text, /deleted_at is null/u);
  assert.match(statement.text, /collate "C"/u);
  assert.match(statement.text, /limit \$5/u);
  assert.equal(Object.isFrozen(statement), true);
  assert.equal(Object.isFrozen(statement.values), true);
});

test('shared production statement rejects unresolved opaque locators', () => {
  assert.throws(
    () => buildPublicationSnapshotCandidateStatement({
      collectionId: 'collection-1',
      limit: 10,
      afterLocator: '0123456789abcdef0123456789abcdef',
    }),
    /requires a resolved continuation tuple/u,
  );
});

test('uses the complete exclusive comparator tuple for continuation', async () => {
  const harness = runtimeWithRows();
  await createPostgresPublicationSnapshotReadPort(harness.runtime).loadPage({
    collectionId: 'collection-1',
    limit: 10,
    after: { parentId: 'parent-1', position: 'B', nodeId: 'node-9' },
  });
  const nodeCall = harness.calls.find((call) => call.sql.includes('row_number() over'));
  assert.deepEqual(nodeCall?.values, ['collection-1', 'parent-1', 'B', 'node-9', 11]);
  assert.match(nodeCall?.sql ?? '', /\) > \(\$2::text/u);
});

test('missing collections commit an empty detached page without reading nodes', async () => {
  const harness = runtimeWithRows({ missing: true });
  const page = await createPostgresPublicationSnapshotReadPort(harness.runtime).loadPage({
    collectionId: 'missing',
    limit: 10,
  });
  assert.equal(page.collection, null);
  assert.equal(page.root, null);
  assert.deepEqual(page.candidates, []);
  assert.equal(harness.calls.some((call) => call.sql.includes('from nodes')), false);
  assert.equal(harness.calls.at(-1)?.sql, 'commit');
});

test('resolves a fixed-size cursor locator before applying the complete exclusive tuple', async () => {
  const harness = runtimeWithRows();
  await createPostgresPublicationSnapshotReadPort(harness.runtime).loadPage({
    collectionId: 'collection-1',
    limit: 10,
    afterLocator: '0123456789abcdef0123456789abcdef',
  });
  const locatorCall = harness.calls.find((call) => call.sql.includes('publication_locator_sha256_128(id)'));
  assert.deepEqual(locatorCall?.values, ['collection-1', '0123456789abcdef0123456789abcdef']);
  assert.match(locatorCall?.sql ?? '', /publication_locator_sha256_128\(id\)/u);
  assert.doesNotMatch(locatorCall?.sql ?? '', /convert_to/u);
  const pageCall = harness.calls.find((call) => call.sql.includes('row_number() over'));
  assert.deepEqual(pageCall?.values, ['collection-1', 'root-1', 'A', 'node-1', 11]);
  assert.match(pageCall?.sql ?? '', /\) > \(\$2::text/u);
});

test('scopes root and depth through a recursive query while preserving tuple continuation', async () => {
  const harness = runtimeWithRows();
  await createPostgresPublicationSnapshotReadPort(harness.runtime).loadPage({
    collectionId: 'collection-1',
    rootId: 'folder-1',
    depth: 3,
    limit: 10,
    after: { parentId: 'folder-1', position: 'A', nodeId: 'node-1' },
  });
  const scoped = harness.calls.find((call) => call.sql.includes('with recursive scoped'));
  assert.deepEqual(scoped?.values, ['collection-1', 'folder-1', 3, 'folder-1', 'A', 'node-1', 11]);
  assert.match(scoped?.sql ?? '', /scope_depth > 0/u);
  assert.match(scoped?.sql ?? '', /with recursive scope_ancestors/u);
  assert.match(scoped?.sql ?? '', /row_number\(\) over/u);
  assert.match(scoped?.sql ?? '', /as publication_position/u);
  assert.match(scoped?.sql ?? '', /parent\.id = n\.parent_id/u);
  assert.match(scoped?.sql ?? '', /select 1 from scope_ancestors where visibility in \('private', 'protected'\)/u);
  assert.match(scoped?.sql ?? '', /\) > \(\$4::text/u);
});

test('rolls back and releases the client when the production candidate statement fails', async () => {
  const harness = runtimeWithRows({ failCandidates: true });
  await assert.rejects(
    createPostgresPublicationSnapshotReadPort(harness.runtime).loadPage({
      collectionId: 'collection-1',
      limit: 10,
    }),
    /candidate read failed/u,
  );
  assert.equal(harness.calls.at(-1)?.sql, 'rollback');
  assert.equal(harness.calls.some((call) => call.sql === 'commit'), false);
  assert.equal(harness.released(), true);
});
