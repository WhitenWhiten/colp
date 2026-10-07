import assert from 'node:assert/strict';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
  type NodeKind,
  type NodeVisibility,
} from '../../src/modules/collections/index.js';
import type { MembershipRole } from '../../src/modules/access-policy/index.js';
import {
  truncateGuardedTablesInTransaction,
} from './postgres-test-runtime.js';

export interface CollectionNodeContractPrincipal {
  readonly principalId: string;
  readonly subjectId: string;
}

export interface CollectionNodeContractCollection {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly rootNodeId: string;
  readonly title?: string;
  readonly summary?: string | null;
  readonly visibility?: 'private' | 'unlisted' | 'public';
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint;
}

export interface CollectionNodeContractNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: NodeKind;
  readonly isRoot?: boolean;
  readonly title?: string;
  readonly url?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly string[];
  readonly visibility?: NodeVisibility;
  readonly positionToken: string | null;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
}

export interface CollectionNodeContractFixture {
  readonly principals: readonly CollectionNodeContractPrincipal[];
  readonly collection: CollectionNodeContractCollection;
  readonly memberships?: readonly {
    readonly subjectId: string;
    readonly role: MembershipRole;
  }[];
  readonly nodes: readonly CollectionNodeContractNode[];
}

/**
 * Rebuilds one isolated-schema collection fixture and materializes the same
 * authoritative payload columns that production canonical writes consume.
 */
export async function resetCollectionNodeContractFixture(
  runtime: DatabaseRuntime,
  fixture: CollectionNodeContractFixture,
): Promise<void> {
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await truncateGuardedTablesInTransaction(client, `
      truncate table product_command_receipts, bookmark_icons, outbox_events, audit_events,
        operations, policy_revisions, content_revisions, children_revisions,
        resource_revisions, collection_policies, collection_members, nodes,
        collections, resource_id_ledger, profiles, accounts cascade
    `);

    for (const principal of fixture.principals) {
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0)`,
        [principal.principalId, principal.subjectId],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, $2, null)`,
        [principal.principalId, `Contract profile ${principal.principalId}`],
      );
    }

    const resourceIds = [
      { id: fixture.collection.id, type: 'collection' },
      ...fixture.nodes.map((node) => ({ id: node.id, type: 'node' })),
    ];
    for (const resource of resourceIds) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, $2)`,
        [resource.id, resource.type],
      );
    }

    const collection = fixture.collection;
    await client.query(
      `insert into collections (
         id, owner_subject_id, title, summary, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, commit_ordinal
       ) values ($1, $2, $3, $4, 'bookmarks', $5, $6, $7, $8, $9, $10)`,
      [
        collection.id,
        collection.ownerSubjectId,
        collection.title ?? 'Collection node adapter contract',
        collection.summary ?? null,
        collection.visibility ?? 'private',
        collection.rootNodeId,
        collection.resourceRevision,
        collection.contentRevision,
        collection.policyRevision,
        collection.commitOrdinal.toString(),
      ],
    );

    for (const membership of fixture.memberships ?? []) {
      await client.query(
        `insert into collection_members(collection_id, subject_id, role)
         values ($1, $2, $3)`,
        [collection.id, membership.subjectId, membership.role],
      );
    }

    for (const node of fixture.nodes) {
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description,
           tags, visibility, position_token, resource_revision, children_revision
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)`,
        [
          node.id,
          collection.id,
          node.parentId,
          node.kind,
          node.isRoot ?? false,
          node.title ?? node.id,
          node.url ?? null,
          node.description ?? null,
          JSON.stringify(node.tags ?? []),
          node.visibility ?? 'inherit',
          node.positionToken,
          node.resourceRevision,
          node.childrenRevision,
        ],
      );
    }

    const collectionRow = (await client.query(
      `select * from collections where id = $1`,
      [collection.id],
    )).rows[0];
    assert.ok(collectionRow);
    const materializedCollection = materializeCollectionPayload({
      id: collectionRow.id,
      ownerSubjectId: collectionRow.owner_subject_id,
      title: collectionRow.title,
      summary: collectionRow.summary,
      kind: collectionRow.kind,
      visibility: collectionRow.visibility,
      rootNodeId: collectionRow.root_node_id,
      resourceRevision: collectionRow.resource_revision,
      contentRevision: collectionRow.content_revision,
      policyRevision: collectionRow.policy_revision,
      commitOrdinal: collectionRow.commit_ordinal,
      createdAt: collectionRow.created_at,
      updatedAt: collectionRow.updated_at,
      deletedAt: collectionRow.deleted_at,
    });
    assert.equal(materializedCollection.ok, true);
    if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
    await client.query(
      `update collections
       set payload_json = $2::jsonb, payload_schema_version = 1,
           payload_authority_status = 'backfilled'
       where id = $1`,
      [collection.id, JSON.stringify(materializedCollection.payload)],
    );

    const nodeRows = await client.query(
      `select * from nodes where collection_id = $1`,
      [collection.id],
    );
    assert.equal(nodeRows.rowCount, fixture.nodes.length);
    for (const row of nodeRows.rows) {
      const materializedNode = materializeNodePayload({
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
      assert.equal(materializedNode.ok, true);
      if (!materializedNode.ok) throw new Error(materializedNode.reason);
      await client.query(
        `update nodes
         set payload_json = $2::jsonb, payload_schema_version = 1,
             payload_authority_status = 'backfilled'
         where id = $1`,
        [row.id, JSON.stringify(materializedNode.payload)],
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

export interface CollectionNodeContractEvidenceCounts {
  readonly receipts: number;
  readonly resourceRevisions: number;
  readonly contentRevisions: number;
  readonly policyRevisions: number;
  readonly childrenRevisions: number;
  readonly operations: number;
  readonly audit: number;
  readonly outbox: number;
}

export async function readCollectionNodeContractEvidenceCounts(
  runtime: DatabaseRuntime,
  collectionId: string,
): Promise<CollectionNodeContractEvidenceCounts> {
  const result = await runtime.pool.query(
    `select
       (select count(*)::integer from product_command_receipts) as receipts,
       (select count(*)::integer from resource_revisions where collection_id = $1) as resource_revisions,
       (select count(*)::integer from content_revisions where collection_id = $1) as content_revisions,
       (select count(*)::integer from policy_revisions where collection_id = $1) as policy_revisions,
       (select count(*)::integer from children_revisions where collection_id = $1) as children_revisions,
       (select count(*)::integer from operations where collection_id = $1) as operations,
       (select count(*)::integer from audit_events where collection_id = $1) as audit,
       (select count(*)::integer from outbox_events where aggregate_scope = $1) as outbox`,
    [collectionId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    receipts: row.receipts,
    resourceRevisions: row.resource_revisions,
    contentRevisions: row.content_revisions,
    policyRevisions: row.policy_revisions,
    childrenRevisions: row.children_revisions,
    operations: row.operations,
    audit: row.audit,
    outbox: row.outbox,
  };
}
