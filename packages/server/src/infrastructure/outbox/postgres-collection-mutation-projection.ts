/**
 * Durable PostgreSQL projection sink for Phase 1 collection/node mutation outbox events.
 *
 * - durability: 'durable' — apply() resolves only after the projection transaction commits
 * - Idempotent on (handler_name, domain_event_id / idempotencyKey)
 * - Fences materialisation by commit_ordinal per (handler_name, aggregate_id)
 * - Never opens or shares the Product mutation / outbox claim transaction
 */

import type { Pool, PoolClient } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import { assertProjectedResourceIsStale } from './collection-mutation-projection-resource-fence.js';
import { projectDeletedNodeSubtree } from './node-delete-subtree-projection.js';
import type {
  CollectionMutationDelivery,
  CollectionMutationProjectionSink,
} from './collection-mutation-events.js';

export type ProjectionApplyDisposition = 'applied' | 'stale_skipped' | 'replay';

export interface CollectionMutationProjectionResourceRow {
  readonly collectionId: string;
  readonly resourceType: 'collection' | 'node' | 'annotation' | 'relation';
  readonly resourceId: string;
  readonly lastHandlerName: string;
  readonly lastEventType: string;
  readonly lastEventVersion: number;
  readonly lastDomainEventId: string;
  readonly lastCommitOrdinal: string;
  readonly stateJson: unknown;
  readonly deleted: boolean;
  readonly updatedAt: Date;
}

export interface CollectionMutationProjectionAppliedRow {
  readonly handlerName: string;
  readonly domainEventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateId: string;
  readonly aggregateScope: string;
  readonly commitOrdinal: string;
  readonly disposition: 'applied' | 'stale_skipped';
  readonly payloadJson: unknown;
  readonly appliedAt: Date;
}

export interface CollectionMutationProjectionWatermarkRow {
  readonly handlerName: string;
  readonly aggregateId: string;
  readonly lastCommitOrdinal: string;
  readonly lastDomainEventId: string;
  readonly updatedAt: Date;
}

export interface CollectionMutationProjectionRepository {
  apply(delivery: CollectionMutationDelivery): Promise<ProjectionApplyDisposition>;
  getApplied(
    handlerName: string,
    domainEventId: string,
  ): Promise<CollectionMutationProjectionAppliedRow | null>;
  getResource(
    collectionId: string,
    resourceType: 'collection' | 'node' | 'annotation' | 'relation',
    resourceId: string,
  ): Promise<CollectionMutationProjectionResourceRow | null>;
  listResources(collectionId: string): Promise<readonly CollectionMutationProjectionResourceRow[]>;
  getWatermark(
    handlerName: string,
    aggregateId: string,
  ): Promise<CollectionMutationProjectionWatermarkRow | null>;
}

async function inTransaction<Result>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    await rollbackTransaction(error, () => client.query('ROLLBACK'), 'Collection mutation projection');
    throw error;
  } finally {
    client.release();
  }
}

function requireScopeAndOrdinal(delivery: CollectionMutationDelivery): {
  readonly aggregateScope: string;
  readonly commitOrdinal: bigint;
} {
  if (delivery.aggregateScope === null || delivery.aggregateScope.length < 1) {
    throw new Error(
      `collection mutation projection requires aggregate_scope `
      + `(handler=${delivery.handlerName}, eventId=${delivery.eventId})`,
    );
  }
  if (delivery.commitOrdinal === null || delivery.commitOrdinal.length < 1) {
    throw new Error(
      `collection mutation projection requires commit_ordinal `
      + `(handler=${delivery.handlerName}, eventId=${delivery.eventId})`,
    );
  }
  let commitOrdinal: bigint;
  try {
    commitOrdinal = BigInt(delivery.commitOrdinal);
  } catch {
    throw new Error(
      `collection mutation projection commit_ordinal is not an integer: ${delivery.commitOrdinal}`,
    );
  }
  if (commitOrdinal <= 0n) {
    throw new Error(
      `collection mutation projection commit_ordinal must be > 0: ${delivery.commitOrdinal}`,
    );
  }
  return { aggregateScope: delivery.aggregateScope, commitOrdinal };
}

interface ProjectionTarget {
  readonly collectionId: string;
  readonly resourceType: 'collection' | 'node' | 'annotation' | 'relation';
  readonly resourceId: string;
  readonly deleted: boolean;
  readonly deleteScope?: 'single' | 'subtree';
  readonly affectedCount?: number;
}

/**
 * Map a validated Phase 1 mutation envelope onto a single projected resource.
 * Fail closed on unknown event types so unknown versions cannot materialise.
 */
export function resolveProjectionTarget(
  delivery: CollectionMutationDelivery,
): ProjectionTarget {
  const payload = delivery.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(
      `collection mutation projection payload must be a closed object `
      + `(${delivery.eventType}@${delivery.eventVersion})`,
    );
  }
  const record = payload as Record<string, unknown>;
  const collectionId = typeof record.collectionId === 'string' && record.collectionId.length > 0
    ? record.collectionId
    : delivery.aggregateId;

  switch (delivery.eventType) {
    case 'collection.created':
    case 'collection.updated':
      return {
        collectionId,
        resourceType: 'collection',
        resourceId: collectionId,
        deleted: false,
      };
    case 'node.restored': case 'node.created':
    case 'node.updated':
    case 'node.moved': {
      const nodeId = record.nodeId;
      if (typeof nodeId !== 'string' || nodeId.length < 1) {
        throw new Error(
          `collection mutation projection missing nodeId for ${delivery.eventType}`,
        );
      }
      return {
        collectionId,
        resourceType: 'node',
        resourceId: nodeId,
        deleted: false,
      };
    }
    case 'node.deleted': {
      const nodeId = record.nodeId;
      if (typeof nodeId !== 'string' || nodeId.length < 1) {
        throw new Error(
          `collection mutation projection missing nodeId for ${delivery.eventType}`,
        );
      }
      const scope = record.scope;
      const affectedCount = record.affectedCount;
      if (
        (scope !== 'single' && scope !== 'subtree')
        || !Number.isSafeInteger(affectedCount)
        || (affectedCount as number) < 1
        || (scope === 'single' && affectedCount !== 1)
      ) {
        throw new Error('collection mutation projection received invalid node.deleted scope or affectedCount');
      }
      return {
        collectionId,
        resourceType: 'node',
        resourceId: nodeId,
        deleted: true,
        deleteScope: scope,
        affectedCount: affectedCount as number,
      };
    }
    case 'annotation.created': {
      const annotationId = record.annotationId;
      if (typeof annotationId !== 'string' || annotationId.length < 1) {
        throw new Error('collection mutation projection missing annotationId for annotation.created');
      }
      return { collectionId, resourceType: 'annotation', resourceId: annotationId, deleted: false };
    }
    case 'annotation.updated': {
      const annotationId = record.annotationId;
      if (typeof annotationId !== 'string' || annotationId.length < 1) {
        throw new Error('collection mutation projection missing annotationId for annotation.updated');
      }
      return { collectionId, resourceType: 'annotation', resourceId: annotationId, deleted: false };
    }
    case 'annotation.deleted': {
      const annotationId = record.annotationId;
      if (typeof annotationId !== 'string' || annotationId.length < 1 || record.affectedCount !== 1) {
        throw new Error('collection mutation projection received invalid annotation.deleted identity or affectedCount');
      }
      return { collectionId, resourceType: 'annotation', resourceId: annotationId, deleted: true,
        deleteScope: 'single', affectedCount: 1 };
    }
    case 'relation.created': {
      const relationId = record.relationId;
      if (typeof relationId !== 'string' || relationId.length < 1) {
        throw new Error('collection mutation projection missing relationId for relation.created');
      }
      return { collectionId, resourceType: 'relation', resourceId: relationId, deleted: false };
    }
    case 'relation.updated': {
      const relationId = record.relationId;
      if (typeof relationId !== 'string' || relationId.length < 1) {
        throw new Error('collection mutation projection missing relationId for relation.updated');
      }
      return { collectionId, resourceType: 'relation', resourceId: relationId, deleted: false };
    }
    case 'relation.deleted': {
      const relationId = record.relationId;
      if (typeof relationId !== 'string' || relationId.length < 1 || record.affectedCount !== 1) {
        throw new Error('collection mutation projection received invalid relation.deleted identity or affectedCount');
      }
      return { collectionId, resourceType: 'relation', resourceId: relationId, deleted: true,
        deleteScope: 'single', affectedCount: 1 };
    }
    default:
      throw new Error(
        `collection mutation projection refuses unknown event type `
        + `${delivery.eventType}@${delivery.eventVersion}`,
      );
  }
}

function mapAppliedRow(row: {
  handler_name: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  aggregate_scope: string;
  commit_ordinal: string;
  disposition: 'applied' | 'stale_skipped';
  payload_json: unknown;
  applied_at: Date;
}): CollectionMutationProjectionAppliedRow {
  return Object.freeze({
    handlerName: row.handler_name,
    domainEventId: row.domain_event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateId: row.aggregate_id,
    aggregateScope: row.aggregate_scope,
    commitOrdinal: String(row.commit_ordinal),
    disposition: row.disposition,
    payloadJson: row.payload_json,
    appliedAt: row.applied_at,
  });
}

function mapResourceRow(row: {
  collection_id: string;
  resource_type: 'collection' | 'node' | 'annotation' | 'relation';
  resource_id: string;
  last_handler_name: string;
  last_event_type: string;
  last_event_version: number;
  last_domain_event_id: string;
  last_commit_ordinal: string;
  state_json: unknown;
  deleted: boolean;
  updated_at: Date;
}): CollectionMutationProjectionResourceRow {
  return Object.freeze({
    collectionId: row.collection_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    lastHandlerName: row.last_handler_name,
    lastEventType: row.last_event_type,
    lastEventVersion: row.last_event_version,
    lastDomainEventId: row.last_domain_event_id,
    lastCommitOrdinal: String(row.last_commit_ordinal),
    stateJson: row.state_json,
    deleted: row.deleted,
    updatedAt: row.updated_at,
  });
}

export class PostgresCollectionMutationProjectionRepository
  implements CollectionMutationProjectionRepository {
  constructor(private readonly pool: Pool) {}

  apply(delivery: CollectionMutationDelivery): Promise<ProjectionApplyDisposition> {
    const { aggregateScope, commitOrdinal } = requireScopeAndOrdinal(delivery);
    const target = resolveProjectionTarget(delivery);
    const payloadJson = JSON.stringify(delivery.payload ?? {});

    return inTransaction(this.pool, async (client) => {
      // Serialise per handler/resource so distinct resources in one collection do not fence.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`cmp:${delivery.handlerName}`, delivery.aggregateId],
      );

      const existing = await client.query<{ domain_event_id: string }>(
        `SELECT domain_event_id
         FROM collection_mutation_projection_applied
         WHERE handler_name = $1 AND domain_event_id = $2`,
        [delivery.handlerName, delivery.eventId],
      );
      if (existing.rows[0]) {
        return 'replay';
      }

      const watermark = await client.query<{ last_commit_ordinal: string }>(
        `SELECT last_commit_ordinal
         FROM collection_mutation_projection_watermarks
         WHERE handler_name = $1 AND aggregate_id = $2
         FOR UPDATE`,
        [delivery.handlerName, delivery.aggregateId],
      );
      const lastOrdinal = watermark.rows[0]
        ? BigInt(watermark.rows[0].last_commit_ordinal)
        : null;

      // Strictly newer ordinals materialise; equal/older are fenced (stale).
      const isStale = lastOrdinal !== null && commitOrdinal <= lastOrdinal;
      let disposition: 'applied' | 'stale_skipped' = isStale ? 'stale_skipped' : 'applied';

      if (!isStale) {
        if (target.deleteScope === 'subtree') {
          if (target.affectedCount === undefined) {
            throw new Error('collection mutation projection missing subtree affectedCount');
          }
          disposition = await projectDeletedNodeSubtree(client, {
            collectionId: target.collectionId,
            rootNodeId: target.resourceId,
            commitOrdinal,
            affectedCount: target.affectedCount,
            handlerName: delivery.handlerName,
            eventType: delivery.eventType,
            eventVersion: delivery.eventVersion,
            eventId: delivery.eventId,
            payloadJson,
          });
        } else {
          const projected = await client.query(
          `INSERT INTO collection_mutation_projection_resources (
             collection_id, resource_type, resource_id,
             last_handler_name, last_event_type, last_event_version,
             last_domain_event_id, last_commit_ordinal, state_json, deleted, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, current_timestamp)
           ON CONFLICT (collection_id, resource_type, resource_id) DO UPDATE
           SET last_handler_name = EXCLUDED.last_handler_name,
               last_event_type = EXCLUDED.last_event_type,
               last_event_version = EXCLUDED.last_event_version,
               last_domain_event_id = EXCLUDED.last_domain_event_id,
               last_commit_ordinal = EXCLUDED.last_commit_ordinal,
               state_json = EXCLUDED.state_json,
               deleted = EXCLUDED.deleted,
               updated_at = current_timestamp
           WHERE collection_mutation_projection_resources.last_commit_ordinal
                 < EXCLUDED.last_commit_ordinal`,
          [
            target.collectionId,
            target.resourceType,
            target.resourceId,
            delivery.handlerName,
            delivery.eventType,
            delivery.eventVersion,
            delivery.eventId,
            commitOrdinal.toString(),
            payloadJson,
            target.deleted,
          ],
          );
          if (projected.rowCount !== 1) {
            await assertProjectedResourceIsStale(client, target, commitOrdinal, projected.rowCount ?? 0);
            disposition = 'stale_skipped';
          }
        }

        await client.query(
          `INSERT INTO collection_mutation_projection_watermarks (
             handler_name, aggregate_id, last_commit_ordinal, last_domain_event_id, updated_at
           ) VALUES ($1, $2, $3, $4, current_timestamp)
           ON CONFLICT (handler_name, aggregate_id) DO UPDATE
           SET last_commit_ordinal = EXCLUDED.last_commit_ordinal,
               last_domain_event_id = EXCLUDED.last_domain_event_id,
               updated_at = current_timestamp
           WHERE collection_mutation_projection_watermarks.last_commit_ordinal
                 < EXCLUDED.last_commit_ordinal`,
          [
            delivery.handlerName,
            delivery.aggregateId,
            commitOrdinal.toString(),
            delivery.eventId,
          ],
        );
      }

      await client.query(
        `INSERT INTO collection_mutation_projection_applied (
           handler_name, domain_event_id, event_type, event_version,
           aggregate_id, aggregate_scope, commit_ordinal, disposition, payload_json, applied_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, current_timestamp)`,
        [
          delivery.handlerName,
          delivery.eventId,
          delivery.eventType,
          delivery.eventVersion,
          delivery.aggregateId,
          aggregateScope,
          commitOrdinal.toString(),
          disposition,
          payloadJson,
        ],
      );

      return disposition;
    });
  }

  async getApplied(
    handlerName: string,
    domainEventId: string,
  ): Promise<CollectionMutationProjectionAppliedRow | null> {
    const result = await this.pool.query<{
      handler_name: string;
      domain_event_id: string;
      event_type: string;
      event_version: number;
      aggregate_id: string;
      aggregate_scope: string;
      commit_ordinal: string;
      disposition: 'applied' | 'stale_skipped';
      payload_json: unknown;
      applied_at: Date;
    }>(
      `SELECT handler_name, domain_event_id, event_type, event_version,
              aggregate_id, aggregate_scope, commit_ordinal, disposition,
              payload_json, applied_at
       FROM collection_mutation_projection_applied
       WHERE handler_name = $1 AND domain_event_id = $2`,
      [handlerName, domainEventId],
    );
    return result.rows[0] ? mapAppliedRow(result.rows[0]) : null;
  }

  async getResource(
    collectionId: string,
    resourceType: 'collection' | 'node' | 'annotation' | 'relation',
    resourceId: string,
  ): Promise<CollectionMutationProjectionResourceRow | null> {
    const result = await this.pool.query<{
      collection_id: string;
      resource_type: 'collection' | 'node' | 'annotation' | 'relation';
      resource_id: string;
      last_handler_name: string;
      last_event_type: string;
      last_event_version: number;
      last_domain_event_id: string;
      last_commit_ordinal: string;
      state_json: unknown;
      deleted: boolean;
      updated_at: Date;
    }>(
      `SELECT collection_id, resource_type, resource_id,
              last_handler_name, last_event_type, last_event_version,
              last_domain_event_id, last_commit_ordinal, state_json, deleted, updated_at
       FROM collection_mutation_projection_resources
       WHERE collection_id = $1 AND resource_type = $2 AND resource_id = $3`,
      [collectionId, resourceType, resourceId],
    );
    return result.rows[0] ? mapResourceRow(result.rows[0]) : null;
  }

  async listResources(
    collectionId: string,
  ): Promise<readonly CollectionMutationProjectionResourceRow[]> {
    const result = await this.pool.query<{
      collection_id: string;
      resource_type: 'collection' | 'node' | 'annotation' | 'relation';
      resource_id: string;
      last_handler_name: string;
      last_event_type: string;
      last_event_version: number;
      last_domain_event_id: string;
      last_commit_ordinal: string;
      state_json: unknown;
      deleted: boolean;
      updated_at: Date;
    }>(
      `SELECT collection_id, resource_type, resource_id,
              last_handler_name, last_event_type, last_event_version,
              last_domain_event_id, last_commit_ordinal, state_json, deleted, updated_at
       FROM collection_mutation_projection_resources
       WHERE collection_id = $1
       ORDER BY resource_type, resource_id`,
      [collectionId],
    );
    return result.rows.map(mapResourceRow);
  }

  async getWatermark(
    handlerName: string,
    aggregateId: string,
  ): Promise<CollectionMutationProjectionWatermarkRow | null> {
    const result = await this.pool.query<{
      handler_name: string;
      aggregate_id: string;
      last_commit_ordinal: string;
      last_domain_event_id: string;
      updated_at: Date;
    }>(
      `SELECT handler_name, aggregate_id, last_commit_ordinal,
              last_domain_event_id, updated_at
       FROM collection_mutation_projection_watermarks
       WHERE handler_name = $1 AND aggregate_id = $2`,
      [handlerName, aggregateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      handlerName: row.handler_name,
      aggregateId: row.aggregate_id,
      lastCommitOrdinal: String(row.last_commit_ordinal),
      lastDomainEventId: row.last_domain_event_id,
      updatedAt: row.updated_at,
    });
  }
}

/**
 * Production-default durable sink. apply() commits the projection transaction
 * before resolving so the worker only completes after durable side-effect success.
 */
export class PostgresCollectionMutationProjectionSink
  implements CollectionMutationProjectionSink {
  readonly durability = 'durable' as const;
  readonly repository: PostgresCollectionMutationProjectionRepository;

  constructor(pool: Pool) {
    this.repository = new PostgresCollectionMutationProjectionRepository(pool);
  }

  async apply(delivery: CollectionMutationDelivery): Promise<void> {
    await this.repository.apply(delivery);
  }
}
