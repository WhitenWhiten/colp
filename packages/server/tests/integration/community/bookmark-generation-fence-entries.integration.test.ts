import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import { createPostgresPublisherCanonicalMutationApplication } from '../../../src/infrastructure/publisher/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import type { ExecutePublisherCanonicalMutationInput } from '../../../src/modules/publisher/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateGuardedTablesInTransaction,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createMcpWriteFixture,
  createPostgresPhase4bMcpWriteHarness,
  writeToolContext,
} from '../../support/postgres-phase4b-mcp-write-tools.js';

/*
 * CS-01/CS-02 bookmark generation fencing: the normalization-equivalent
 * rewrite pin through the two non-HTTP write entries (the product HTTP
 * PATCH leg lives in bookmark-generation-fence-http.integration.test.ts,
 * and the interaction-fence angle through every entry — including
 * collection-version restore — lives in
 * bookmark-generation-entries.integration.test.ts):
 *
 * - MCP `nodes.update` (real `bundle.adapter.callTool` against the
 *   PostgreSQL canonical mutation UoW), and
 * - the publisher canonical mutation application
 *   (`createPostgresPublisherCanonicalMutationApplication`)
 *
 * each rotate the minted `bm-gen-*` generation on semantic URL rewrites
 * (A→B, then B→A minting a third value — never a rewind) while the
 * normalization-equivalent rewrite pin keeps the stored raw URL and
 * preserves the generation.
 */

const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: PRINCIPAL_ID,
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'epoch-1',
});
const SCOPES = Object.freeze(['nodes:write', 'access:write', 'changes:commit', 'changes:cancel']);

describeWithPostgres('CS-02 bookmark generation fence via MCP and publisher', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_gen_fence_entries', {
      maxConnections: 12,
      applicationName: 'known-community-gen-fence-entries-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  beforeEach(async () => {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table community_bookmark_generations, community_votes,
          publisher_idempotency, product_command_receipts, outbox_events,
          audit_events, audit_event_payloads, operations, policy_revisions,
          content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, nodes, collections,
          resource_id_ledger, profiles, accounts,
          mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`, [PRINCIPAL_ID]);
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Fence owner', null)`, [PRINCIPAL_ID]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  async function generationOf(collectionId: string, nodeId: string): Promise<string> {
    const row = (await runtime.pool.query<{ generation: string }>(
      `select generation from community_bookmark_generations
       where collection_id=$1 and node_id=$2`, [collectionId, nodeId])).rows[0];
    assert.ok(row, 'a stored bookmark always owns a generation row');
    return row.generation;
  }

  async function nodeFacts(collectionId: string, nodeId: string) {
    const row = (await runtime.pool.query<{
      url: string; resource_revision: string;
    }>(`select url, resource_revision from nodes
        where collection_id=$1 and id=$2`, [collectionId, nodeId])).rows[0];
    assert.ok(row);
    return row;
  }

  test('MCP nodes.update rotates A→B→A and pins equivalent rewrites', async () => {
    const fixture = await createMcpWriteFixture(runtime, BINDING, SCOPES);
    const { collectionId, nodeId } = fixture;
    const genA = await generationOf(collectionId, nodeId);
    const urlA = (await nodeFacts(collectionId, nodeId)).url;
    const urlB = 'https://mcp.example/rotated';

    const mcpUpdate = async (url: string) => {
      const current = await nodeFacts(collectionId, nodeId);
      const result = await createPostgresPhase4bMcpWriteHarness(runtime, BINDING, SCOPES)
        .bundle.adapter.callTool(
          writeToolContext(BINDING, SCOPES, 'nodes.update', collectionId),
          {
            name: 'nodes.update',
            arguments: {
              collectionId,
              nodeId,
              baseRevision: current.resource_revision,
              patch: { url },
            },
          },
        );
      assert.equal(result.resultType, 'complete');
      const output = result.structuredContent as { resultType?: string };
      assert.equal(output.resultType, 'complete');
    };

    // A→B then B→A: two semantic rewrites, two fresh generations.
    await mcpUpdate(urlB);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlB);
    const genB = await generationOf(collectionId, nodeId);
    assert.notEqual(genB, genA);
    await mcpUpdate(urlA);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlA);
    const genA2 = await generationOf(collectionId, nodeId);
    assert.notEqual(genA2, genB);
    assert.notEqual(genA2, genA);

    // Equivalent rewrite is pinned: generation and stored raw URL survive.
    await mcpUpdate(`${urlA}/`);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlA);
    assert.equal(await generationOf(collectionId, nodeId), genA2);
  }, 60_000);

  test('publisher canonical updates rotate A→B→A and pin equivalent rewrites', async () => {
    const collectionId = randomBytes(16).toString('base64url');
    const rootId = randomBytes(16).toString('base64url');
    const nodeId = randomBytes(16).toString('base64url');
    const urlA = 'https://publisher.example/alpha';
    const urlB = 'https://publisher.example/beta';
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [collectionId, rootId, nodeId]);
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, publication_slug,
           published_at, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Publisher fence', 'bookmarks', 'public',
           'publisher-fence', current_timestamp, $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [collectionId, PRINCIPAL_ID, rootId]);
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, tags, visibility,
           position_token, resource_revision, children_revision
         ) values
           ($2, $1, null, 'folder', true, 'Root', null, '[]'::jsonb, 'inherit', null,
             'root-r1', 'root-children-r1'),
           ($3, $1, $2, 'bookmark', false, 'Fence', $4,
             '[]'::jsonb, 'inherit', 'U', 'node-r1', 'node-children-r1')`,
        [collectionId, rootId, nodeId, urlA]);
      const collectionRow = (await client.query(
        'select * from collections where id=$1', [collectionId])).rows[0];
      const materializedCollection = materializeCollectionPayload({
        id: collectionRow.id, ownerSubjectId: collectionRow.owner_subject_id,
        title: collectionRow.title, summary: collectionRow.summary,
        kind: collectionRow.kind, visibility: collectionRow.visibility,
        rootNodeId: collectionRow.root_node_id,
        resourceRevision: collectionRow.resource_revision,
        contentRevision: collectionRow.content_revision,
        policyRevision: collectionRow.policy_revision,
        commitOrdinal: collectionRow.commit_ordinal,
        createdAt: collectionRow.created_at, updatedAt: collectionRow.updated_at,
        deletedAt: collectionRow.deleted_at,
      });
      assert.equal(materializedCollection.ok, true);
      if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
      await client.query(
        `update collections set payload_json=$2::jsonb, payload_schema_version=1,
           payload_authority_status='backfilled' where id=$1`,
        [collectionId, JSON.stringify(materializedCollection.payload)]);
      for (const nodeRow of (await client.query(
        'select * from nodes where collection_id=$1', [collectionId])).rows) {
        const materialized = materializeNodePayload({
          id: nodeRow.id, collectionId: nodeRow.collection_id, parentId: nodeRow.parent_id,
          kind: nodeRow.kind, isRoot: nodeRow.is_root, title: nodeRow.title, url: nodeRow.url,
          description: nodeRow.description, tags: nodeRow.tags, visibility: nodeRow.visibility,
          positionToken: nodeRow.position_token, resourceRevision: nodeRow.resource_revision,
          childrenRevision: nodeRow.children_revision, createdAt: nodeRow.created_at,
          updatedAt: nodeRow.updated_at, deletedAt: nodeRow.deleted_at,
          deletedCommitOrdinal: nodeRow.deleted_commit_ordinal,
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) throw new Error(materialized.reason);
        await client.query(
          `update nodes set payload_json=$2::jsonb, payload_schema_version=1,
             payload_authority_status='backfilled' where id=$1`,
          [nodeRow.id, JSON.stringify(materialized.payload)]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const application = createPostgresPublisherCanonicalMutationApplication(runtime.db);
    const publisherUpdate = async (url: string) => {
      const current = await nodeFacts(collectionId, nodeId);
      const input: ExecutePublisherCanonicalMutationInput = {
        binding: {
          namespace: 'colp.publisher.v0.1.nodes.update',
          principalId: PRINCIPAL_ID,
          idempotencyKey: `publisher-fence-${randomUUID()}`,
        },
        payload: { kind: 'bookmark', title: 'Fence', url },
        collectionId,
        operationId: randomUUID(),
        mutation: {
          action: 'update',
          target: { collectionId, resourceId: nodeId, resourceKind: 'node' },
          parentId: rootId,
          expectedResourceRevision: current.resource_revision,
          fields: { kindFields: {
            kind: 'bookmark', title: 'Fence', url,
            description: null, tags: [], visibility: 'inherit',
          }, extensions: {} },
        },
      };
      const outcome = await application.execute(input);
      assert.equal(outcome.kind, 'executed', 'the publisher mutation must commit');
    };

    const genA = await generationOf(collectionId, nodeId);
    await publisherUpdate(urlB);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlB);
    const genB = await generationOf(collectionId, nodeId);
    assert.notEqual(genB, genA);
    await publisherUpdate(urlA);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlA);
    const genA2 = await generationOf(collectionId, nodeId);
    assert.notEqual(genA2, genB);
    assert.notEqual(genA2, genA);
    await publisherUpdate(`${urlA}/`);
    assert.equal((await nodeFacts(collectionId, nodeId)).url, urlA,
      'the equivalent rewrite is pinned to the stored raw spelling');
    assert.equal(await generationOf(collectionId, nodeId), genA2);
  }, 60_000);
});
