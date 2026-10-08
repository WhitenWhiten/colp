import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Annotation } from '@know-n/colp/types';
import { sql, type Kysely, type Selectable } from 'kysely';
import { canonicalJson } from '../../modules/commands/index.js';
import {
  AnnotationProductReadError,
  formatUtcDateTime,
  type AnnotationReadUnitOfWork,
  type ProductAnnotationCursorSignerPort,
  type ProductAnnotationReadPort,
  type ProductAnnotationRow,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';
import { createPostgresCollectionsClock } from './repositories.js';

const validators = createValidatorRegistry();

export interface PostgresAnnotationReadUnitOfWorkOptions {
  readonly cursorSigner: ProductAnnotationCursorSignerPort;
  readonly cursorTtlMs?: number;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly metrics?: Metrics;
}

export function createPostgresAnnotationReadUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresAnnotationReadUnitOfWorkOptions,
): AnnotationReadUnitOfWork {
  const unit = createUnitOfWork(db, { isolationLevel: 'repeatable read', faultInjector: options.faultInjector });
  return {
    execute(work) {
      return unit.execute(({ transaction }) => work({
        reads: createPostgresAnnotationReadPort(transaction, options.metrics),
        accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
        cursorSigner: options.cursorSigner,
        clock: createPostgresCollectionsClock(transaction),
        cursorTtlMs: options.cursorTtlMs,
      }));
    },
  };
}

export function createPostgresAnnotationReadPort(
  transaction: DatabaseTransaction,
  metrics?: Metrics,
): ProductAnnotationReadPort {
  return {
    async collectionNotesRevision(collectionId) {
      const row = await transaction.selectFrom('collections').select('content_revision').where('id', '=', collectionId).where('deleted_at', 'is', null).executeTakeFirst();
      return row?.content_revision ?? null;
    },
    async listPrivateCollectionNotes(input) {
      let query = transaction.selectFrom('annotations').selectAll('annotations')
        .innerJoin('nodes', join => join.onRef('nodes.id', '=', 'annotations.subject_id').onRef('nodes.collection_id', '=', 'annotations.collection_id'))
        .where('annotations.collection_id', '=', input.collectionId).where('annotations.creator_principal_id', '=', input.principalId)
        .where('annotations.subject_type', '=', 'node').where('annotations.type', '=', 'note').where('annotations.visibility', '=', 'private')
        .where('annotations.deleted_at', 'is', null).where('nodes.deleted_at', 'is', null);
      if (input.after) { const date = parseCanonicalDate(input.after.updatedAt); query = query.where(eb => eb.or([
        eb('annotations.updated_at', '<', date), eb.and([eb('annotations.updated_at', '=', date), sql<boolean>`annotations.id COLLATE "C" > ${input.after!.id} COLLATE "C"`]),
      ])); }
      const rows = await query.orderBy('annotations.updated_at', 'desc').orderBy(sql`annotations.id COLLATE "C"`, 'asc').limit(input.limit + 1).execute();
      return rows.map(row => mapProductAnnotationRow(row, metrics));
    },
    async loadLiveSubject(input) {
      if (input.resourceType === 'collection') {
        const row = await transaction.selectFrom('collections')
          .select(['id', 'visibility', 'deleted_at'])
          .where('id', '=', input.resourceId).where('id', '=', input.collectionId)
          .executeTakeFirst();
        return row && row.deleted_at === null ? {
          type: 'collection', id: row.id, collectionId: row.id, visibility: row.visibility,
        } : null;
      }
      const row = await transaction.selectFrom('nodes')
        .innerJoin('collections', 'collections.id', 'nodes.collection_id')
        .select(['nodes.id', 'nodes.collection_id', 'nodes.deleted_at',
          'collections.visibility as collection_visibility', 'collections.deleted_at as collection_deleted_at'])
        .select(sql<'private' | 'protected' | 'unlisted' | 'public'>`
          CASE
            WHEN nodes.visibility <> 'inherit' THEN nodes.visibility
            WHEN EXISTS (
              WITH RECURSIVE ancestors AS (
                SELECT parent.id, parent.parent_id, parent.visibility, parent.deleted_at,
                       ARRAY[parent.id]::text[] AS path
                  FROM nodes parent
                 WHERE parent.collection_id = nodes.collection_id
                   AND parent.id = nodes.parent_id
                UNION ALL
                SELECT parent.id, parent.parent_id, parent.visibility, parent.deleted_at,
                       child.path || parent.id::text
                  FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
                 WHERE parent.collection_id = nodes.collection_id
                   AND NOT parent.id = ANY(child.path)
              )
              SELECT 1 FROM ancestors
               WHERE deleted_at IS NOT NULL OR visibility = 'private'
            ) THEN 'private'
            WHEN EXISTS (
              WITH RECURSIVE ancestors AS (
                SELECT parent.id, parent.parent_id, parent.visibility, parent.deleted_at,
                       ARRAY[parent.id]::text[] AS path
                  FROM nodes parent
                 WHERE parent.collection_id = nodes.collection_id
                   AND parent.id = nodes.parent_id
                UNION ALL
                SELECT parent.id, parent.parent_id, parent.visibility, parent.deleted_at,
                       child.path || parent.id::text
                  FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
                 WHERE parent.collection_id = nodes.collection_id
                   AND NOT parent.id = ANY(child.path)
              )
              SELECT 1 FROM ancestors WHERE visibility = 'protected'
            ) THEN 'protected'
            ELSE collections.visibility
          END`.as('visibility'))
        .where('nodes.id', '=', input.resourceId).where('nodes.collection_id', '=', input.collectionId)
        .executeTakeFirst();
      if (!row || row.deleted_at !== null || row.collection_deleted_at !== null) return null;
      return { type: 'node', id: row.id, collectionId: row.collection_id,
        visibility: row.visibility };
    },
    async loadLiveById(input) {
      const row = await transaction.selectFrom('annotations').selectAll()
        .where('collection_id', '=', input.collectionId).where('id', '=', input.annotationId)
        .where('deleted_at', 'is', null).executeTakeFirst();
      return row ? mapProductAnnotationRow(row, metrics) : null;
    },
    async listLiveBySubject(input) {
      let query = transaction.selectFrom('annotations').selectAll()
        .where('collection_id', '=', input.collectionId)
        .where('subject_type', '=', input.resourceType).where('subject_id', '=', input.resourceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([
          eb('creator_principal_id', '=', input.principalId),
          eb('visibility', 'in', input.includeProtected
            ? ['public', 'unlisted', 'protected']
            : ['public', 'unlisted']),
        ]));
      if (input.after) {
        const updatedAt = parseCanonicalDate(input.after.updatedAt);
        query = query.where('updated_at', '<=', updatedAt)
          .where((eb) => eb.or([
            eb('updated_at', '<', updatedAt),
            eb.and([
              eb('updated_at', '=', updatedAt),
              sql<boolean>`id COLLATE "C" > ${input.after!.id} COLLATE "C"`,
            ]),
          ]));
      }
      const rows = await query.orderBy('updated_at', 'desc').orderBy(sql`id COLLATE "C"`, 'asc')
        .limit(input.limit + 1).execute();
      return rows.map((row) => mapProductAnnotationRow(row, metrics));
    },
  };
}

export function mapProductAnnotationRow(row: Selectable<DatabaseSchema['annotations']>, metrics?: Metrics): ProductAnnotationRow {
  const payload = row.payload_json as unknown;
  const structural = validators.validate('annotation', payload);
  if (!structural.valid) return authorityFailure(metrics);
  const annotation = payload as Annotation;
  if (!annotation.creator || annotation.id !== row.id || annotation.collectionId !== row.collection_id
    || annotation.subject.type !== row.subject_type || annotation.subject.id !== row.subject_id
    || annotation.type !== row.type || (annotation.format ?? null) !== row.format
    || canonicalJson(annotation.value) !== canonicalJson(row.value_json)
    || annotation.visibility !== row.visibility || annotation.revision !== row.resource_revision
    || annotation.createdAt !== formatUtcDateTime(row.created_at)
    || annotation.updatedAt !== formatUtcDateTime(row.updated_at)
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled') {
    return authorityFailure(metrics);
  }
  return Object.freeze({
    id: row.id, collectionId: row.collection_id, subjectType: row.subject_type,
    subjectId: row.subject_id, creatorPrincipalId: row.creator_principal_id,
    payload: Object.freeze(structuredClone(annotation)), resourceRevision: row.resource_revision,
    updatedAt: row.updated_at, deletedAt: row.deleted_at,
  });
}

function authorityFailure(metrics?: Metrics): never {
  metrics?.increment('resource_authority_mismatch_total');
  throw new Error('Annotation relational/payload authority mismatch');
}

function parseCanonicalDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || formatUtcDateTime(parsed) !== value) {
    throw new AnnotationProductReadError('invalid_cursor');
  }
  return parsed;
}
