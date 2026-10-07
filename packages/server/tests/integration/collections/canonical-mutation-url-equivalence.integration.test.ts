import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'canonical-adapter-root';
const NODE_ID = 'canonical-adapter-node';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';

/**
 * The community bookmark generation fence (`community_bookmark_generations`
 * is trigger-minted on every bookmark INSERT/url UPDATE) must not observe
 * semantic drift when a caller rewrites a normalization-equivalent URL
 * spelling: the canonical write pins the stored raw string back, so the
 * generation survives — while a genuinely different URL still rotates it.
 */
describeWithPostgres('PostgreSQL canonical mutation url equivalence', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('canonical_url_equivalence', {
      maxConnections: 6,
      applicationName: 'known-canonical-url-equivalence-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function resetFixture(): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, nodes, collections, resource_id_ledger,
          profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Canonical adapter owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [COLLECTION_ID, ROOT_ID, NODE_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Canonical', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values
         ($1, $3, null, 'folder', true, 'Canonical', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1'),
         ($2, $3, $1, 'bookmark', false, 'Before', 'https://example.test/before', null, '[]'::jsonb,
          'inherit', 'U', 'node-r1', 'node-children-r1')`,
        [ROOT_ID, NODE_ID, COLLECTION_ID],
      );
      const fixtureCollection = (await client.query(
        'select * from collections where id = $1',
        [COLLECTION_ID],
      )).rows[0];
      const materializedCollection = materializeCollectionPayload({
        id: fixtureCollection.id,
        ownerSubjectId: fixtureCollection.owner_subject_id,
        title: fixtureCollection.title,
        summary: fixtureCollection.summary,
        kind: fixtureCollection.kind,
        visibility: fixtureCollection.visibility,
        rootNodeId: fixtureCollection.root_node_id,
        resourceRevision: fixtureCollection.resource_revision,
        contentRevision: fixtureCollection.content_revision,
        policyRevision: fixtureCollection.policy_revision,
        commitOrdinal: fixtureCollection.commit_ordinal,
        createdAt: fixtureCollection.created_at,
        updatedAt: fixtureCollection.updated_at,
        deletedAt: fixtureCollection.deleted_at,
      });
      assert.equal(materializedCollection.ok, true);
      if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
      await client.query(
        `update collections
          set payload_json = $2::jsonb, payload_schema_version = 1,
              payload_authority_status = 'backfilled'
          where id = $1`,
        [COLLECTION_ID, JSON.stringify(materializedCollection.payload)],
      );
      const fixtureNodes = await client.query('select * from nodes where id = any($1::text[])', [[ROOT_ID, NODE_ID]]);
      for (const row of fixtureNodes.rows) {
        const materialized = materializeNodePayload({
          id: row.id,
          collectionId: row.collection_id,
          parentId: row.parent_id,
          kind: row.kind,
          isRoot: row.is_root,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: row.tags,
          visibility: row.visibility,
          positionToken: row.position_token,
          resourceRevision: row.resource_revision,
          childrenRevision: row.children_revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
          deletedCommitOrdinal: row.deleted_commit_ordinal,
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) throw new Error(materialized.reason);
        await client.query(
          `update nodes
            set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
            where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  function mutation(operationId: string, expectedResourceRevision = 'node-r1'): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'update',
        target: { collectionId: COLLECTION_ID, resourceId: NODE_ID, resourceKind: 'node' },
        parentId: ROOT_ID,
        expectedResourceRevision,
        fields: {
          kindFields: {
            kind: 'bookmark',
            title: 'After',
            url: 'https://example.test/after',
            description: 'canonical write',
            tags: ['adapter'],
            visibility: 'inherit',
          },
          extensions: { 'example.test/source': 'caller-must-not-overwrite' },
        },
      },
    };
  }

  async function executeMutation(input: CanonicalMutationInput) {
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: `canonical:${input.mutation.action}`,
      commandId: input.operationId,
    };
    const fingerprint = `fp-${input.operationId}`;
    return createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      assert.deepEqual(await ports.receipts.claim(binding, fingerprint), { kind: 'claimed' });
      const result = await ports.canonical.execute(input);
      await ports.receipts.complete(binding, fingerprint, {
        status: 200,
        body: Buffer.from(JSON.stringify({ operationId: input.operationId })),
        stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: input.mutation.target.resourceId,
      });
      return result;
    });
  }

  test('a normalization-equivalent bookmark url keeps the stored spelling and its generation', async () => {
    await resetFixture();
    const generation = async () => (await runtime.pool.query(
      'select generation from community_bookmark_generations where collection_id = $1 and node_id = $2',
      [COLLECTION_ID, NODE_ID],
    )).rows[0]?.generation as string;
    const stored = async () => (await runtime.pool.query(
      'select url, search_url_host, resource_revision, payload_json from nodes where id = $1',
      [NODE_ID],
    )).rows[0];
    const urlWrite = async (
      operationId: string,
      url: string,
      extra: Record<string, unknown> = {},
    ): Promise<CanonicalMutationInput> => {
      const input = mutation(operationId, (await stored()).resource_revision);
      const kindFields = input.mutation.fields!.kindFields as Record<string, unknown>;
      kindFields.url = url;
      Object.assign(kindFields, extra);
      return input;
    };

    const generation0 = await generation();
    assert.equal(typeof generation0, 'string');

    // Equivalent spelling (scheme/host case, default port, trailing slash,
    // fragment) carrying a digest of the unadopted bytes: the stored raw url
    // wins, the foreign hash is dropped, and the fence does not rotate.
    await executeMutation(await urlWrite(
      '41111111-1111-4111-8111-111111111111',
      'HTTPS://EXAMPLE.TEST:443/before/#frag',
      { urlHash: 'sha-256=:dW5hZG9wdGVkLXNwZWxsaW5n:', canonicalUrl: 'https://example.test/before' },
    ));
    let row = await stored();
    assert.equal(row.url, 'https://example.test/before');
    assert.equal(row.search_url_host, 'example.test');
    assert.equal(row.payload_json.url, 'https://example.test/before');
    assert.equal(Object.hasOwn(row.payload_json, 'urlHash'), false);
    assert.equal(await generation(), generation0);

    // A genuinely different URL persists verbatim and rotates the fence.
    await executeMutation(await urlWrite(
      '42222222-2222-4222-8222-222222222222',
      'https://example.test/replaced',
    ));
    row = await stored();
    assert.equal(row.url, 'https://example.test/replaced');
    const generation1 = await generation();
    assert.notEqual(generation1, generation0);

    // A → B → A: returning to the original URL is a semantic change and must
    // mint a third generation, not resurrect the first.
    await executeMutation(await urlWrite(
      '43333333-3333-4333-8333-333333333333',
      'https://example.test/before',
    ));
    row = await stored();
    assert.equal(row.url, 'https://example.test/before');
    const generation2 = await generation();
    assert.notEqual(generation2, generation1);
    assert.notEqual(generation2, generation0);
  });
});
