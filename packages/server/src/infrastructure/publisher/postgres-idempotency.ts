import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { stableReplayHeaders } from '../../modules/commands/index.js';
import type {
  PublisherCreateOwnedCollectionHarnessPorts,
  PublisherIdempotencyClaim,
  PublisherIdempotencyPort,
  PublisherReceiptMaintenancePort,
} from '../../modules/publisher/index.js';
import { PUBLISHER_MIN_REPLAY_WINDOW_SECONDS } from '../../modules/publisher/index.js';
import { bootstrapCanonicalOwnedCollection } from '../../modules/collections/index.js';
import { createPostgresCollectionsWritePorts } from '../collections/index.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

function assertBindingFields(
  namespace: string,
  principalId: string,
  idempotencyKey: string,
): void {
  if (!namespace?.trim()) throw new Error('publisher namespace is required');
  if (!principalId?.trim()) throw new Error('publisher principalId is required');
  if (!idempotencyKey?.trim()) throw new Error('publisher idempotencyKey is required');
}

/**
 * PostgreSQL Publisher idempotency adapter.
 * Transaction is supplied by the admission-layer unit of work (no nested tx).
 */
export function createPostgresPublisherIdempotencyPort(
  transaction: DatabaseTransaction,
): PublisherIdempotencyPort {
  return {
    async claim(binding, fingerprint): Promise<PublisherIdempotencyClaim> {
      assertBindingFields(binding.namespace, binding.principalId, binding.idempotencyKey);
      if (!fingerprint?.trim()) throw new Error('publisher fingerprint is required');

      const inserted = await transaction.insertInto('publisher_idempotency').values({
        namespace: binding.namespace,
        principal_id: binding.principalId,
        idempotency_key: binding.idempotencyKey,
        request_fingerprint: fingerprint,
        claimed_at: sql<Date>`current_timestamp`,
        contract_version: '1.0.0',
      }).onConflict((oc) => oc.columns(['namespace', 'principal_id', 'idempotency_key']).doNothing())
        .returning('idempotency_key').executeTakeFirst();
      if (inserted) return { kind: 'claimed' };

      const row = await transaction.selectFrom('publisher_idempotency').selectAll()
        .where('namespace', '=', binding.namespace)
        .where('principal_id', '=', binding.principalId)
        .where('idempotency_key', '=', binding.idempotencyKey)
        .forUpdate().executeTakeFirstOrThrow();

      if (row.request_fingerprint !== fingerprint) return { kind: 'reused' };
      if (row.completed_at === null) {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      return {
        kind: 'replay',
        result: {
          status: row.result_status!,
          body: row.result_bytes!,
          stableHeaders: row.result_headers ?? {},
          mediaType: row.result_media_type!,
          contractVersion: row.contract_version,
          targetIdentity: row.target_identity ?? undefined,
        },
      };
    },

    async complete(binding, fingerprint, result): Promise<void> {
      assertBindingFields(binding.namespace, binding.principalId, binding.idempotencyKey);
      const body = Buffer.from(result.body);
      const digest = createHash('sha256').update(body).digest('hex');
      const updated = await transaction.updateTable('publisher_idempotency').set({
        result_status: result.status,
        result_headers: stableReplayHeaders(result.stableHeaders),
        result_media_type: result.mediaType,
        result_bytes: body,
        result_digest: digest,
        contract_version: result.contractVersion,
        target_identity: result.targetIdentity ?? null,
        completed_at: sql<Date>`current_timestamp`,
        result_expires_at: sql<Date>`current_timestamp + (${PUBLISHER_MIN_REPLAY_WINDOW_SECONDS} * interval '1 second')`,
      }).where('namespace', '=', binding.namespace)
        .where('principal_id', '=', binding.principalId)
        .where('idempotency_key', '=', binding.idempotencyKey)
        .where('request_fingerprint', '=', fingerprint)
        .where('completed_at', 'is', null).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error('publisher receipt was not claim owner');
      }
    },
  };
}

/** Transaction-bound bounded cleanup used only by the Worker maintenance loop. */
export function createPostgresPublisherReceiptMaintenancePort(
  transaction: DatabaseTransaction,
): PublisherReceiptMaintenancePort {
  return {
    async purgeExpired(options = {}): Promise<number> {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
      const deleted = await sql<{ idempotency_key: string }>`
        WITH expired AS (
          SELECT namespace, principal_id, idempotency_key
          FROM publisher_idempotency
          WHERE completed_at IS NOT NULL
            AND result_expires_at <= current_timestamp
          ORDER BY result_expires_at, namespace, principal_id, idempotency_key
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        DELETE FROM publisher_idempotency AS receipt
        USING expired
        WHERE receipt.namespace = expired.namespace
          AND receipt.principal_id = expired.principal_id
          AND receipt.idempotency_key = expired.idempotency_key
        RETURNING receipt.idempotency_key
      `.execute(transaction);
      return deleted.rows.length;
    },
  };
}

export function createPostgresPublisherReceiptMaintenancePortFactory(
  db: Kysely<DatabaseSchema>,
): () => Promise<PublisherReceiptMaintenancePort> {
  return async () => ({
    purgeExpired: (options) => createUnitOfWork(db).execute(({ transaction }) =>
      createPostgresPublisherReceiptMaintenancePort(transaction).purgeExpired(options)),
  });
}

/**
 * Transaction-bound ports for runPublisherCreateOwnedCollectionHarness.
 * Uses publisher_idempotency instead of product_command_receipts; shares the
 * canonical collections bootstrap (ID ledger, Collection+Root, membership/
 * policy, Operation/Audit/Outbox) with the Product surface.
 */
export function createPostgresPublisherCreateOwnedCollectionHarnessPorts(
  transaction: DatabaseTransaction,
): PublisherCreateOwnedCollectionHarnessPorts {
  const writePorts = createPostgresCollectionsWritePorts(transaction);
  return {
    publisherIdempotency: createPostgresPublisherIdempotencyPort(transaction),
    clock: writePorts.clock,
    collections: {
      lockForUpdate: (collectionId) => writePorts.collections.lockForUpdate(collectionId),
    },
    nodes: {
      getNode: (collectionId, nodeId) => writePorts.nodes.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId, parentId, maxDepth) =>
        writePorts.nodes.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId, parentId) =>
        writePorts.nodes.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId, parentId) =>
        writePorts.nodes.hasLiveChildren!(collectionId, parentId),
    },
    accessPolicy: writePorts.accessPolicyFacts,
    canonical: {
      async bootstrapOwnedCollection(input) {
        return bootstrapCanonicalOwnedCollection(writePorts, input);
      },
      async execute() {
        throw new Error('publisher create-owned-collection harness only supports collection bootstrap');
      },
    },
  };
}
