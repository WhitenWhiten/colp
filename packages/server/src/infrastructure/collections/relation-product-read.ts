import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Relation } from '@know-n/colp/types';
import { sql, type Kysely } from 'kysely';
import { RelationProductReadError, formatUtcDateTime, type ProductRelationCursorSignerPort,
  type ProductRelationReadPort, type ProductRelationRow, type RelationReadUnitOfWork } from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';
import { createPostgresCollectionsClock } from './repositories.js';
const validators = createValidatorRegistry();

export interface PostgresRelationReadUnitOfWorkOptions {
  readonly cursorSigner: ProductRelationCursorSignerPort; readonly cursorTtlMs?: number;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector']; readonly metrics?: Metrics;
}
export function createPostgresRelationReadUnitOfWork(db: Kysely<DatabaseSchema>, options: PostgresRelationReadUnitOfWorkOptions): RelationReadUnitOfWork {
  const unit = createUnitOfWork(db, { isolationLevel: 'repeatable read', faultInjector: options.faultInjector });
  return { execute: (work) => unit.execute(({ transaction }) => work({
    reads: createPostgresRelationReadPort(transaction, options.metrics),
    accessPolicy: createPostgresAccessPolicyFactsPort(transaction), cursorSigner: options.cursorSigner,
    clock: createPostgresCollectionsClock(transaction), cursorTtlMs: options.cursorTtlMs,
  })) };
}
export function createPostgresRelationReadPort(transaction: DatabaseTransaction, metrics?: Metrics): ProductRelationReadPort {
  return {
    async loadLiveNode(input) {
      const row = await transaction.selectFrom('nodes').innerJoin('collections', 'collections.id', 'nodes.collection_id')
        .select(['nodes.id', 'nodes.collection_id', 'nodes.visibility', 'nodes.deleted_at',
          'collections.visibility as collection_visibility', 'collections.deleted_at as collection_deleted_at'])
        .where('nodes.id', '=', input.nodeId).where('nodes.collection_id', '=', input.collectionId).executeTakeFirst();
      if (!row || row.deleted_at || row.collection_deleted_at) return null;
      return { id: row.id, collectionId: row.collection_id,
        visibility: row.visibility === 'inherit' ? row.collection_visibility : row.visibility };
    },
    async loadLiveById(input) {
      const row = await transaction.selectFrom('relations').selectAll().where('collection_id', '=', input.collectionId)
        .where('id', '=', input.relationId).where('deleted_at', 'is', null).executeTakeFirst();
      return row ? mapRow(row, metrics) : null;
    },
    async listLiveByNode(input) {
      let query = transaction.selectFrom('relations')
        .innerJoin('nodes as relation_from', 'relation_from.id', 'relations.from_node_id')
        .innerJoin('nodes as relation_to', 'relation_to.id', 'relations.to_node_id')
        .innerJoin('collections as relation_collection', 'relation_collection.id', 'relations.collection_id')
        .selectAll('relations').select([
          sql<'private' | 'protected' | 'unlisted' | 'public'>`CASE WHEN relation_from.visibility = 'inherit'
            THEN relation_collection.visibility ELSE relation_from.visibility END`.as('from_visibility'),
          sql<'private' | 'protected' | 'unlisted' | 'public'>`CASE WHEN relation_to.visibility = 'inherit'
            THEN relation_collection.visibility ELSE relation_to.visibility END`.as('to_visibility'),
        ]).where('relations.collection_id', '=', input.collectionId)
        .where(input.direction === 'outgoing' ? 'relations.from_node_id' : 'relations.to_node_id', '=', input.nodeId)
        .where('relations.deleted_at', 'is', null).where('relation_from.deleted_at', 'is', null)
        .where('relation_to.deleted_at', 'is', null).where('relation_collection.deleted_at', 'is', null);
      if (input.types.length > 0) query = query.where('relations.type', 'in', input.types);
      if (input.visibilities.length > 0) query = query.where('relations.visibility', 'in', input.visibilities);
      const endpointVisibilityList = sql.join(input.endpointVisibilities.map((visibility) => sql`${visibility}`));
      query = query.where(sql<boolean>`(CASE WHEN relation_from.visibility = 'inherit'
        THEN relation_collection.visibility ELSE relation_from.visibility END) IN (${endpointVisibilityList})`)
        .where(sql<boolean>`(CASE WHEN relation_to.visibility = 'inherit'
          THEN relation_collection.visibility ELSE relation_to.visibility END) IN (${endpointVisibilityList})`);
      if (input.after) { const updated = parseDate(input.after.updatedAt);
        query = query.where((eb) => eb.or([eb('relations.updated_at', '<', updated), eb.and([
          eb('relations.updated_at', '=', updated), sql<boolean>`relations.id COLLATE "C" > ${input.after!.id} COLLATE "C"`])])); }
      const rows = await query.orderBy('relations.updated_at', 'desc').orderBy(sql`relations.id COLLATE "C"`, 'asc')
        .limit(input.limit + 1).execute();
      return rows.map((row) => ({ ...mapRow(row, metrics), fromVisibility: row.from_visibility,
        toVisibility: row.to_visibility }));
    },
  };
}
function mapRow(row: DatabaseSchema['relations'], metrics?: Metrics): ProductRelationRow {
  const payload = row.payload_json as unknown; const structural = validators.validate('relation', payload);
  if (!structural.valid) return failure(metrics); const relation = payload as Relation;
  if (relation.id !== row.id || relation.collectionId !== row.collection_id || relation.fromNodeId !== row.from_node_id
    || relation.toNodeId !== row.to_node_id || relation.type !== row.type || (relation.label ?? null) !== row.label
    || relation.visibility !== row.visibility || relation.revision !== row.resource_revision
    || relation.createdAt !== formatUtcDateTime(row.created_at) || relation.updatedAt !== formatUtcDateTime(row.updated_at)
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled') return failure(metrics);
  return Object.freeze({ id: row.id, collectionId: row.collection_id, fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id, payload: Object.freeze(structuredClone(relation)), resourceRevision: row.resource_revision,
    updatedAt: row.updated_at, deletedAt: row.deleted_at });
}
function failure(metrics?: Metrics): never { metrics?.increment('resource_authority_mismatch_total'); throw new Error('Relation relational/payload authority mismatch'); }
function parseDate(value: string) { const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || formatUtcDateTime(parsed) !== value) throw new RelationProductReadError('invalid_cursor'); return parsed; }
