import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createMcpWriteProductPorts } from '../../../src/bootstrap/mcp-write-postgres-ports.js';
import {
  backfillResourcePayloads,
  createPostgresClassifyInboxAcceptUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { createPostgresReplicaStore } from '../../../src/infrastructure/sync/index.js';
import {
  acceptClassifyInboxItem,
  type ProductCollectionCanonicalPorts,
} from '../../../src/modules/collections/index.js';
import { createPhase4bMcpLowRiskNodeCreateService } from '../../../src/modules/mcp/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * A-03 / B0-3 / SR-03: the two write paths that have no Replica/Sequence
 * identity — MCP `changes.commit` (ports from `createMcpWriteProductPorts`)
 * and classify-inbox accept (`assembleCollectionPorts` via
 * `createPostgresClassifyInboxAcceptUnitOfWork`) — persist Operations with
 * `sync_wire_present = false`, so an incremental Push/Pull reader can never
 * observe them. Both must therefore mark every `status = 'active'` Replica of
 * the Collection `recovery_required` and force the Snapshot path.
 *
 * The assertions read the real `sync_replicas` rows (never source text), and
 * every case seeds its own Replica and first proves it really was `active`
 * before the write: a green run cannot be vacuous and neither case depends on
 * the other case having run. Pre-fix (flag absent) the trailing
 * `recovery_required` assertion is red.
 *
 * Fixture provenance:
 * - canonical Collection/owner identities, account/profile/Collection/root
 *   seeding and `createPostgresReplicaStore` usage follow
 *   `sync-node-create-postgres.integration.test.ts:26-33,52-104,132-149`
 *   (the canonical node-write fixture);
 * - the classify-inbox eligible bookmark/folder seed and the payload backfill
 *   follow `tests/integration/collections/classify-inbox-postgres.integration.test.ts:23-121`.
 * - The Collection identity must be canonical (16-byte base64url) because
 *   every canonical node write routes `social collection change` domain events
 *   and `appendSocialCollectionChangeOutbox` validates `collectionId` **and**
 *   the owner profile id (`accounts.id`) with `requireCanonicalOpaqueId`
 *   (`src/infrastructure/outbox/social-collection-change.ts:14,82-84,168-192`).
 */

const OWNER_ACCOUNT_ID = 'BgYGBgYGBgYGBgYGBgYGBg'; // accounts.id; also the social owner profile id
const OWNER_SUBJECT_ID = 'a03-owner-subject'; // accounts.subject_id; owns the Collection
const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ'; // canonical 16-byte base64url Collection identity
const ROOT_ID = 'a03-root';
const INBOX_BOOKMARK_ID = 'a03-inbox-bookmark';
const INBOX_FOLDER_ID = 'a03-inbox-folder';
const INBOX_BOOKMARK_REVISION = 'a03-inbox-bookmark-r1';

const REPLICA_CAPABILITIES = {
  read: true,
  write: true,
  events: true,
  separator: false,
  alias: false,
  annotations: 'sidecar' as const,
  maxBatchOperations: 1,
};

/** Host-verified authenticated binding, same shape the MCP transport produces. */
const MCP_BINDING = Object.freeze({
  kind: 'authenticated' as const,
  principalId: OWNER_ACCOUNT_ID,
  clientId: 'known-a03-write-client',
  credentialBindingId: 'a03-credential-binding',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'a03-security-epoch',
});

interface ReplicaRow {
  readonly replicaId: string;
  readonly status: string;
  readonly lifecycleRevision: number;
  readonly wireStatus: string | null;
}

describeWithPostgres('A-03 invisible write paths invalidate active replicas', () => {
  let isolated: IsolatedPostgresRuntime;
  let replicaCounter = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('a03_replica_invalidation', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCanonicalCollection();
    // The canonical adapters assert resource-payload authority, so materialize
    // the relational fixture rows exactly like the classify-inbox fixture does.
    await backfillResourcePayloads(isolated.runtime.db);
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('MCP changes.commit node write forces every active replica into Snapshot recovery', async () => {
    // Seeding the replicas inside the case keeps it independent of the other
    // case's writes; the only requirement is that they are `active` right now.
    const seeded = [await createActiveReplica(), await createActiveReplica()];
    const replicasBefore = await readReplicaRows();
    const activeBefore = replicasBefore.filter((row) => row.status === 'active');
    for (const replica of seeded) {
      assert.ok(
        activeBefore.some((row) => row.replicaId === replica.replicaId),
        `replica ${replica.replicaId} must be an active reader before the MCP write`,
      );
    }
    assert.ok(activeBefore.length >= 2, 'the MCP case must start from live incremental readers');
    const operationsBefore = await readOperationWireFacts();
    const baseRevisions = await readCreateBaseRevisions();

    let createdNodeId = '';
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      // `changes.commit` composes its transaction-bound ports through this
      // factory (`mcp-write-composition.ts` `createProductPorts` ->
      // `createMcpWriteProductPorts`) and runs the `nodes.create` canonical
      // executor reproduced here.
      const ports = createMcpWriteProductPorts(transaction);
      const service = createPhase4bMcpLowRiskNodeCreateService({
        unitOfWork: Object.freeze({
          execute: async <Result>(
            work: (value: ProductCollectionCanonicalPorts) => Promise<Result>,
          ): Promise<Result> => work(ports),
        }),
      });
      const output = await service.execute({
        input: {
          tool: 'nodes.create',
          collectionId: COLLECTION_ID,
          parentId: ROOT_ID,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: 'A-03 MCP commit bookmark',
            url: 'https://example.test/a03-mcp-commit',
            description: null,
            tags: [],
            visibility: 'private',
          },
          reason: 'A-03 replica invalidation evidence',
          confirmApply: true,
        },
        idempotencyKey: randomUUID(),
        expectedBaseRevisions: {
          [`children.${ROOT_ID}`]: baseRevisions.childrenRevision,
          [`content.${COLLECTION_ID}`]: baseRevisions.contentRevision,
          [`policy.${COLLECTION_ID}`]: baseRevisions.policyRevision,
        },
      }, {
        binding: MCP_BINDING,
        accountSubjectId: OWNER_SUBJECT_ID,
        scope: ['nodes:write'],
      });
      assert.equal(output.resultType, 'complete');
      if (output.resultType === 'complete') createdNodeId = output.node.id;
    });

    const node = await isolated.runtime.pool.query<{ parent_id: string | null }>(
      'select parent_id from nodes where id = $1 and deleted_at is null',
      [createdNodeId],
    );
    assert.equal(node.rows.length, 1, 'the MCP write must be durably committed');
    assert.equal(node.rows[0]?.parent_id, ROOT_ID);

    // The reason the invalidation is the only honest delivery: the Operation
    // landed without a COLP Sync wire identity.
    const operationsAfter = await readOperationWireFacts();
    assert.ok(
      operationsAfter.total > operationsBefore.total,
      'the MCP write must append at least one Operation',
    );
    assert.equal(
      operationsAfter.withSyncWire,
      0,
      'changes.commit Operations must persist sync_wire_present = false',
    );

    await assertEveryActiveReplicaInvalidated(replicasBefore);
  }, 60_000);

  test('classify-inbox accept forces every active replica into Snapshot recovery', async () => {
    // Seeding the replica inside the case keeps it independent of the MCP case:
    // whatever else is still `active` at this point is asserted on as well.
    const seeded = await createActiveReplica();
    assert.equal(seeded.status, 'active');

    const replicasBefore = await readReplicaRows();
    const activeBefore = replicasBefore.filter((row) => row.status === 'active');
    assert.ok(
      activeBefore.some((row) => row.replicaId === seeded.replicaId),
      'the freshly seeded replica must be an active reader before the accept',
    );
    const operationsBefore = await readOperationWireFacts();

    const accept = createPostgresClassifyInboxAcceptUnitOfWork(isolated.runtime.db);
    const result = await accept.execute((ports) => acceptClassifyInboxItem(ports, {
      actor: { principalId: OWNER_ACCOUNT_ID, subjectId: OWNER_SUBJECT_ID },
      commandId: randomUUID(),
      nodeId: INBOX_BOOKMARK_ID,
      ifMatch: `"${INBOX_BOOKMARK_REVISION}"`,
      body: { suggestionId: INBOX_FOLDER_ID },
    }));
    assert.equal(result.kind, 'succeeded');

    const moved = await isolated.runtime.pool.query<{ parent_id: string | null }>(
      'select parent_id from nodes where id = $1 and deleted_at is null',
      [INBOX_BOOKMARK_ID],
    );
    assert.equal(
      moved.rows[0]?.parent_id,
      INBOX_FOLDER_ID,
      'the accept must move the node into the suggested folder',
    );

    const operationsAfter = await readOperationWireFacts();
    assert.ok(
      operationsAfter.total > operationsBefore.total,
      'the accept must append at least one Operation',
    );
    assert.equal(
      operationsAfter.withSyncWire,
      0,
      'classify-inbox accept Operations must persist sync_wire_present = false',
    );

    await assertEveryActiveReplicaInvalidated(replicasBefore);
  }, 60_000);

  /**
   * Seeds one real Replica through the production store — the same call the
   * shared Sync session harness and the canonical node-create fixture make —
   * so the row starts at `status = 'active'` with matching `wire_json.status`.
   */
  async function createActiveReplica() {
    const n = ++replicaCounter;
    return createPostgresReplicaStore(isolated.runtime.db, {
      ids: {
        deviceId: () => `a03-device-${n}`,
        replicaId: () => `a03-replica-${n}`,
        leaseId: () => `a03-lease-${n}`,
      },
    }).create({
      accountId: OWNER_ACCOUNT_ID,
      collectionId: COLLECTION_ID,
      deviceName: 'A-03 device',
      replicaName: 'A-03 replica',
      kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: REPLICA_CAPABILITIES,
      binding: {
        browserProfileId: `a03-profile-${n}`,
        mountMode: 'mounted-folder',
        browserGeneration: `a03-generation-${n}`,
      },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: OWNER_ACCOUNT_ID });
  }

  async function readReplicaRows(): Promise<readonly ReplicaRow[]> {
    const result = await isolated.runtime.pool.query<{
      replica_id: string;
      status: string;
      lifecycle_revision: string;
      wire_status: string | null;
    }>(
      `select replica_id, status, lifecycle_revision::text as lifecycle_revision,
              wire_json->>'status' as wire_status
         from sync_replicas
        where collection_id = $1
        order by replica_id`,
      [COLLECTION_ID],
    );
    return result.rows.map((row) => ({
      replicaId: row.replica_id,
      status: row.status,
      lifecycleRevision: Number(row.lifecycle_revision),
      wireStatus: row.wire_status,
    }));
  }

  /**
   * Every replica that was `active` before the write must now be
   * `recovery_required`, with a bumped lifecycle revision and the matching
   * wire fact; no active row may survive. `before` is the full snapshot taken
   * before the write, so the expectation is anchored on real pre-state.
   */
  async function assertEveryActiveReplicaInvalidated(
    before: readonly ReplicaRow[],
  ): Promise<void> {
    const activeBefore = before.filter((row) => row.status === 'active');
    assert.ok(activeBefore.length > 0, 'the fixture must have an active replica before the write');
    const after = await readReplicaRows();
    assert.equal(after.length, before.length, 'the write must not add or remove sync_replicas rows');
    for (const replica of activeBefore) {
      const row = after.find((candidate) => candidate.replicaId === replica.replicaId);
      assert.ok(row, `replica ${replica.replicaId} must survive the write`);
      assert.equal(
        row.status,
        'recovery_required',
        `replica ${replica.replicaId} must be forced into Snapshot recovery`,
      );
      assert.equal(
        row.lifecycleRevision,
        replica.lifecycleRevision + 1,
        `replica ${replica.replicaId} must bump its lifecycle revision`,
      );
      assert.equal(
        row.wireStatus,
        'recovery_required',
        `replica ${replica.replicaId} must publish recovery_required on its wire facts`,
      );
    }
    assert.deepEqual(
      after.filter((row) => row.status === 'active'),
      [],
      'no active replica may survive the write',
    );
  }

  async function readOperationWireFacts(): Promise<{
    readonly total: number;
    readonly withSyncWire: number;
  }> {
    const result = await isolated.runtime.pool.query<{
      total: string;
      with_sync_wire: string;
    }>(
      `select count(*)::text as total,
              count(*) filter (where sync_wire_present)::text as with_sync_wire
         from operations
        where collection_id = $1`,
      [COLLECTION_ID],
    );
    return {
      total: Number(result.rows[0]?.total ?? '0'),
      withSyncWire: Number(result.rows[0]?.with_sync_wire ?? '0'),
    };
  }

  async function readCreateBaseRevisions(): Promise<{
    readonly childrenRevision: string;
    readonly contentRevision: string;
    readonly policyRevision: string;
  }> {
    const result = await isolated.runtime.pool.query<{
      children_revision: string;
      content_revision: string;
      policy_revision: string;
    }>(
      `select n.children_revision, c.content_revision, c.policy_revision
         from collections c
         join nodes n on n.id = c.root_node_id
        where c.id = $1 and c.deleted_at is null and n.deleted_at is null`,
      [COLLECTION_ID],
    );
    const row = result.rows[0];
    assert.ok(row, 'the fixture must seed the canonical Collection root');
    return {
      childrenRevision: row.children_revision,
      contentRevision: row.content_revision,
      policyRevision: row.policy_revision,
    };
  }

  /**
   * Seeds the canonical owner account/profile, Collection, root and the
   * classify-inbox eligible bookmark (live bookmark directly under the root,
   * no decision sidecar, non-empty URL) plus the suggestion folder.
   */
  async function seedCanonicalCollection(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0)`,
        [OWNER_ACCOUNT_ID, OWNER_SUBJECT_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'A-03 owner', null)`,
        [OWNER_ACCOUNT_ID],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node')`,
        [COLLECTION_ID, ROOT_ID, INBOX_BOOKMARK_ID, INBOX_FOLDER_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'A-03 canonical', null, 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 0)`,
        [COLLECTION_ID, OWNER_SUBJECT_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision,
           created_at, updated_at
         ) values
         ($1, $4, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit',
          null, 'root-r1', 'root-children-r1', current_timestamp, current_timestamp),
         ($2, $4, $1, 'bookmark', false, 'A-03 classify inbox bookmark',
          'https://example.test/a03-inbox', null, '[]'::jsonb, 'inherit', 'A', $5, $6,
          current_timestamp, current_timestamp),
         ($3, $4, $1, 'folder', false, 'A-03 classify inbox folder',
          null, null, '[]'::jsonb, 'inherit', 'B', 'a03-inbox-folder-r1',
          'a03-inbox-folder-cr1', current_timestamp, current_timestamp)`,
        [
          ROOT_ID, INBOX_BOOKMARK_ID, INBOX_FOLDER_ID, COLLECTION_ID,
          INBOX_BOOKMARK_REVISION, 'a03-inbox-bookmark-cr1',
        ],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
});
