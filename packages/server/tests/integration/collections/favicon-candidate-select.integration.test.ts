import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresFaviconCandidatePort } from '../../../src/infrastructure/collections/index.js';
import { FAVICON_JOB_CANDIDATE_LIMIT } from '../../../src/infrastructure/collections/favicon-job-items-postgres.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
} from '../../../src/modules/collections/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER = Buffer.alloc(16, 91).toString('base64url');
const OTHER = Buffer.alloc(16, 92).toString('base64url');
const COLLECTION_A = Buffer.alloc(16, 93).toString('base64url');
const COLLECTION_B = Buffer.alloc(16, 94).toString('base64url');
const COLLECTION_OTHER = Buffer.alloc(16, 95).toString('base64url');
const ROOT_A = Buffer.alloc(16, 96).toString('base64url');
const ROOT_B = Buffer.alloc(16, 97).toString('base64url');
const ROOT_OTHER = Buffer.alloc(16, 98).toString('base64url');
const PER_COLLECTION = 40;

describeWithPostgres('favicon listCandidates is owner-scoped and account-capped', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_candidate_select');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedLibraries(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('fill_missing returns every owned bookmark across collections and no foreign-owner rows', async () => {
    const candidates = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresFaviconCandidatePort(transaction).listCandidates({
        accountId: OWNER,
        accountSubjectId: OWNER,
        operation: 'fill_missing',
        onlineDefault: true,
      }),
    );
    const owned = await isolated.runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from nodes n
         join collections c on c.id = n.collection_id
       where c.owner_subject_id = $1 and c.deleted_at is null
         and n.deleted_at is null and n.kind = 'bookmark'`,
      [OWNER],
    );
    const ownedCount = Number(owned.rows[0]?.n);
    assert.equal(ownedCount, PER_COLLECTION * 2);
    assert.ok(ownedCount <= FAVICON_JOB_CANDIDATE_LIMIT);
    assert.equal(candidates.length, ownedCount);
    assert.equal(candidates.some((row) => row.collectionId === COLLECTION_OTHER), false);
    const ids = new Set(candidates.map((row) => row.nodeId));
    assert.equal(ids.size, PER_COLLECTION * 2);
  }, 60_000);
});

async function seedLibraries(runtime: IsolatedPostgresRuntime): Promise<void> {
  const now = new Date('2026-08-20T00:00:00Z');
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $1, 'active'), ($2, $2, 'active')`,
      [OWNER, OTHER],
    );
    await client.query(
      `insert into profiles(account_id, display_name, avatar_url) values ($1, 'NV02 owner', null), ($2, 'NV02 other', null)`,
      [OWNER, OTHER],
    );
    await seedCollection(client, now, COLLECTION_A, ROOT_A, OWNER, 'nv02-a', PER_COLLECTION);
    await seedCollection(client, now, COLLECTION_B, ROOT_B, OWNER, 'nv02-b', PER_COLLECTION);
    await seedCollection(client, now, COLLECTION_OTHER, ROOT_OTHER, OTHER, 'nv02-other', 10);
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch { /* already failed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function seedCollection(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  now: Date,
  collectionId: string,
  rootId: string,
  owner: string,
  title: string,
  bookmarkCount: number,
): Promise<void> {
  const collection = materializeCollectionPayload({
    id: collectionId, ownerSubjectId: owner, title, summary: null, kind: 'bookmarks',
    visibility: 'private', rootNodeId: rootId, resourceRevision: 'r1', contentRevision: 'c1',
    policyRevision: 'p1', commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
  });
  const root = materializeNodePayload({
    id: rootId, collectionId, parentId: null, kind: 'folder', isRoot: true, title: 'Root',
    url: null, description: null, tags: [], visibility: 'inherit', positionToken: null,
    resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now,
    deletedAt: null, deletedCommitOrdinal: null,
  });
  if (!collection.ok || !root.ok) throw new Error('favicon candidate payload failed');
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
    [collectionId, rootId],
  );
  await client.query(
    `insert into collections
       (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
        content_revision, policy_revision, commit_ordinal, created_at, updated_at,
        payload_json, payload_schema_version, payload_authority_status)
     values ($1, $2, $3, 'bookmarks', 'private', $4, 'r1', 'c1', 'p1', 0, $5, $5, $6, $7, 'backfilled')`,
    [collectionId, owner, title, rootId, now, collection.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION],
  );
  await client.query(
    `insert into nodes
       (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
        resource_revision, children_revision, created_at, updated_at, payload_json,
        payload_schema_version, payload_authority_status)
     values ($1, $2, null, 'folder', true, 'Root', null, 'inherit', null, 'root-r1', 'children-r1',
             $3, $3, $4, $5, 'backfilled')`,
    [rootId, collectionId, now, root.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION],
  );
  for (let index = 0; index < bookmarkCount; index += 1) {
    const nodeId = `nv02-${title}-n${String(index).padStart(3, '0')}`;
    const bookmark = materializeNodePayload({
      id: nodeId, collectionId, parentId: rootId, kind: 'bookmark', isRoot: false,
      title: `${title}-${index}`, url: `https://example.test/${title}/${index}`,
      description: null, tags: [], visibility: 'inherit',
      positionToken: `P${index.toString().padStart(5, '0')}`,
      resourceRevision: `b-r${index}`, childrenRevision: `b-c${index}`,
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    if (!bookmark.ok) throw new Error('favicon candidate bookmark payload failed');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [nodeId],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision, created_at, updated_at, payload_json,
          payload_schema_version, payload_authority_status)
       values ($1, $2, $3, 'bookmark', false, $4, $5, 'inherit', $6, $7, $8, $9, $9, $10, $11, 'backfilled')`,
      [nodeId, collectionId, rootId, `${title}-${index}`, `https://example.test/${title}/${index}`,
        `P${index.toString().padStart(5, '0')}`, `b-r${index}`, `b-c${index}`, now,
        bookmark.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION],
    );
  }
}
