/**
 * FO-07 review P1-1: the legacy-upload backfill migration plus the exclusion
 * of backfilled `uploaded` nodes from automatic online jobs.
 *
 * Pre-feature bookmarks had a `bookmark_icons` binding but no source row; the
 * migration `202610012800` upgrades those bindings to explicit `uploaded`
 * rows so refresh_online / fill / single-node refresh never replace the user's
 * manually uploaded icon under an online default ("自动任务……不得覆盖
 * uploaded"). A fresh deployment has nothing to backfill; the candidate
 * exclusion is asserted against the migrated state.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresFaviconCandidatePort,
  createPostgresCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createCollectionNode,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { createUnitOfWork, createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRE_BACKFILL = '202610012700_favicon_tombstone_gc';
const OWNER = Buffer.alloc(16, 31).toString('base64url');
const COLLECTION = Buffer.alloc(16, 32).toString('base64url');
const ROOT = Buffer.alloc(16, 33).toString('base64url');
const LEGACY_UPLOAD = Buffer.alloc(16, 34).toString('base64url');
const FRESH_BOOKMARK = Buffer.alloc(16, 35).toString('base64url');
const LEGACY_OBJECT = '123e4567-e89b-42d3-a456-426614174010';
const DIGEST = Buffer.alloc(32, 7);

describeWithPostgres('favicon legacy-upload backfill (FO-07 review P1)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_legacy_backfill');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('backfill migration upgrades a pre-feature binding to an uploaded source row', async () => {
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const previous = await migrator.migrateTo(PRE_BACKFILL);
    if (previous.error) throw previous.error;

    await seedPreFeatureUpload(isolated);

    const before = await isolated.runtime.pool.query<{ n: string }>(
      'select count(*)::text as n from bookmark_icon_sources where node_id = $1',
      [LEGACY_UPLOAD],
    );
    assert.equal(before.rows[0]?.n, '0');

    const latest = await migrator.migrateToLatest();
    if (latest.error) throw latest.error;

    const rows = await isolated.runtime.pool.query<{ source_mode: string; revision: string }>(
      'select source_mode, revision from bookmark_icon_sources where node_id = $1',
      [LEGACY_UPLOAD],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.source_mode, 'uploaded');
    assert.equal(rows.rows[0]?.revision, '1');

    const binding = await isolated.runtime.pool.query<{ n: string }>(
      'select count(*)::text as n from bookmark_icons where node_id = $1',
      [LEGACY_UPLOAD],
    );
    assert.equal(binding.rows[0]?.n, '1');
  });

  test('refresh_online candidates exclude the backfilled uploaded node but include untouched nodes', async () => {
    // isolated is now at latest, with LEGACY_UPLOAD carrying an uploaded row.
    // Add a fresh inherit bookmark (no binding, no source row) post-backfill.
    await createCanonicalBookmark(isolated, FRESH_BOOKMARK);

    const candidates = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresFaviconCandidatePort(transaction).listCandidates({
        accountId: OWNER,
        accountSubjectId: OWNER,
        operation: 'refresh_online',
        onlineDefault: true,
      }),
    );

    const ids = candidates.map((candidate) => candidate.nodeId);
    assert.ok(
      !ids.includes(LEGACY_UPLOAD),
      'the backfilled uploaded node must never be refreshable by an automatic job',
    );
    assert.ok(
      ids.includes(FRESH_BOOKMARK),
      'an untouched inherit node must remain refreshable under an online default',
    );
    for (const candidate of candidates) {
      if (candidate.nodeId === LEGACY_UPLOAD) {
        assert.fail('legacy uploaded node selected as a refresh_online candidate');
      }
    }
  });
});

async function seedPreFeatureUpload(runtime: IsolatedPostgresRuntime): Promise<void> {
  // The isolated runtime is a dedicated schema: seed from scratch (no clean-up
  // needed), mirroring the pre-feature data shape (binding, no source row).
  // collections↔nodes carry a circular FK, so the seed runs in one transaction
  // with deferred constraints (same pattern as the bookmark-icons suite).
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $1, 'active')`,
      [OWNER],
    );
    await client.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'Legacy upload owner', null)`,
      [OWNER],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [COLLECTION, ROOT],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
          content_revision, policy_revision, commit_ordinal, updated_at)
       values ($1, $2, 'legacy-upload', 'bookmarks', 'private', $3, 'r1', 'c1', 'p1', 1,
               timestamptz '2026-08-20T00:00:00Z')`,
      [COLLECTION, OWNER, ROOT],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
      [ROOT, COLLECTION],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ($1, $2, 'owner')`,
      [COLLECTION, OWNER],
    );
    // The pre-feature bookmark: binding present, source row absent.
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [LEGACY_UPLOAD],
    );
    await client.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision
       ) values ($1, $2, $3, 'bookmark', false, 'Legacy upload', 'https://example.test/legacy',
                 'p1', 'r1', 'ch1')`,
      [LEGACY_UPLOAD, COLLECTION, ROOT],
    );
    await client.query(
      `insert into bookmark_icons (
         node_id, collection_id, object_id, content_type, byte_size, digest_sha256
       ) values ($1, $2, $3, 'image/png', 16, $4)`,
      [LEGACY_UPLOAD, COLLECTION, LEGACY_OBJECT, DIGEST],
    );
    await backfillPayloads(client);
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch { /* already failed */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Dual-read surfaces need canonical payload_json; backfill it for the seed rows. */
async function backfillPayloads(client: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  const collection = (await client.query('select * from collections where id = $1', [COLLECTION])).rows[0]!;
  const collectionPayload = materializeCollectionPayload({
    id: collection.id,
    ownerSubjectId: collection.owner_subject_id,
    title: collection.title,
    summary: collection.summary,
    kind: collection.kind,
    visibility: collection.visibility,
    rootNodeId: collection.root_node_id,
    resourceRevision: collection.resource_revision,
    contentRevision: collection.content_revision,
    policyRevision: collection.policy_revision,
    commitOrdinal: collection.commit_ordinal,
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
    deletedAt: collection.deleted_at,
  });
  if (!collectionPayload.ok) throw new Error(collectionPayload.reason);
  await client.query(
    `update collections
        set payload_json = $2::jsonb, payload_schema_version = 1,
            payload_authority_status = 'backfilled'
      where id = $1`,
    [COLLECTION, JSON.stringify(collectionPayload.payload)],
  );
  for (const nodeId of [ROOT, LEGACY_UPLOAD]) {
    const node = (await client.query('select * from nodes where id = $1', [nodeId])).rows[0]!;
    const payload = materializeNodePayload({
      id: node.id,
      collectionId: node.collection_id,
      parentId: node.parent_id,
      kind: node.kind,
      isRoot: node.is_root,
      title: node.title,
      url: node.url,
      description: node.description,
      tags: node.tags,
      visibility: node.visibility,
      positionToken: node.position_token,
      resourceRevision: node.resource_revision,
      childrenRevision: node.children_revision,
      createdAt: node.created_at,
      updatedAt: node.updated_at,
      deletedAt: node.deleted_at,
      deletedCommitOrdinal: node.deleted_commit_ordinal,
    });
    if (!payload.ok) throw new Error(payload.reason);
    await client.query(
      `update nodes
          set payload_json = $2::jsonb, payload_schema_version = 1,
              payload_authority_status = 'backfilled'
        where id = $1`,
      [nodeId, JSON.stringify(payload.payload)],
    );
  }
}

async function createCanonicalBookmark(
  runtime: IsolatedPostgresRuntime,
  nodeId: string,
): Promise<void> {
  const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime.runtime.db);
  const fingerprint = `favicon-legacy-backfill-${nodeId}`;
  const created = await unitOfWork.execute((ports) => createCollectionNode(ports, {
    actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
    command: {
      commandId: commandIdFromFingerprint(fingerprint),
      fingerprint,
    },
    operationId: Buffer.from(fingerprint).subarray(0, 16).toString('base64url').padEnd(22, 'A'),
    collectionId: COLLECTION,
    parentId: ROOT,
    afterId: null,
    beforeId: null,
    nodeId,
    node: {
      kind: 'bookmark',
      title: `Fresh ${nodeId}`,
      url: 'https://example.test/fresh',
      description: null,
      tags: [],
      visibility: 'inherit',
    },
  }));
  assert.equal(created.kind, 'created');
  if (created.kind !== 'created') throw new Error('expected create');
}

function commandIdFromFingerprint(fingerprint: string): string {
  const hex = Buffer.from(fingerprint).toString('hex').padEnd(32, 'a').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}