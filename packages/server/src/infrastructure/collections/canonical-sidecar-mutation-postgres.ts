import { randomBytes } from 'node:crypto';
import { validateAnnotationProvenance } from '@know-n/colp/semantic';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Annotation } from '@know-n/colp/types';
import type { Relation, RelationCreate } from '@know-n/colp/types';
import { sql } from 'kysely';
import {
  ANNOTATION_CREATED_EVENT_TYPE,
  ANNOTATION_CREATED_EVENT_VERSION,
  ANNOTATION_CREATED_HANDLER_NAME,
  ANNOTATION_DELETED_EVENT_TYPE,
  ANNOTATION_DELETED_EVENT_VERSION,
  ANNOTATION_DELETED_HANDLER_NAME,
  ANNOTATION_UPDATED_EVENT_TYPE,
  ANNOTATION_UPDATED_EVENT_VERSION,
  ANNOTATION_UPDATED_HANDLER_NAME,
  CanonicalMutationInvariantError,
  RELATION_CREATED_EVENT_TYPE,
  RELATION_CREATED_EVENT_VERSION,
  RELATION_CREATED_HANDLER_NAME,
  RELATION_DELETED_EVENT_TYPE,
  RELATION_DELETED_EVENT_VERSION,
  RELATION_DELETED_HANDLER_NAME,
  RELATION_UPDATED_EVENT_TYPE,
  RELATION_UPDATED_EVENT_VERSION,
  RELATION_UPDATED_HANDLER_NAME,
  assertAnnotationDeletedPayload,
  assertAnnotationUpdatedPayload,
  formatUtcDateTime,
  type AnnotationAuthorityRecord,
  type CanonicalDomainEvent,
  type CanonicalMutationInput,
  type CanonicalMutationPlan,
  type CanonicalResourceWrite,
  type RelationAuthorityRecord,
} from '../../modules/collections/index.js';
import { canonicalJson } from '../../modules/commands/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendReportSourceInvalidation, type ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../outbox/publication-cache-purge.js';
interface CollectionFenceRow {
  readonly id: string;
  readonly resource_revision: string;
  readonly content_revision: string;
  readonly policy_revision: string;
  readonly commit_ordinal: bigint;
  readonly publication_slug: string | null;
  readonly published_at: Date | null;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly payload_json: Record<string, unknown> | null;
}

interface RawCollectionFenceRow extends Omit<CollectionFenceRow, 'commit_ordinal'> {
  readonly commit_ordinal: bigint | string;
}

export interface SidecarUpdateFacts {
  readonly previousVisibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly publicRepresentationChanged: boolean;
}

export interface SidecarMutationWriteContext {
  readonly faultInjector?: {
    afterPhase?(context: { readonly phase: string; readonly resourceId?: string }): void | Promise<void>;
  };
  readonly outboxIdGenerator?: () => string;
  readonly updateFacts?: SidecarUpdateFacts;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

const validators = createValidatorRegistry();

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

function authorityInvariant(message: string): never {
  throw new CanonicalMutationInvariantError('resource_field_authority_violation', message);
}

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

async function reserve(tx: DatabaseTransaction, resourceId: string, resourceType: string): Promise<void> {
  // Ledger rows are immutable (no UPDATE/DELETE). Re-creating a sidecar after the
  // row was removed must reuse the existing identity instead of failing closed.
  // Cross-type reuse of the same id must still fail closed.
  const inserted = await tx.insertInto('resource_id_ledger').values({
    resource_id: resourceId, resource_type: resourceType, committed_at: sql<Date>`current_timestamp`,
  }).onConflict((conflict) => conflict.column('resource_id').doNothing())
    .returning('resource_type')
    .executeTakeFirst();
  if (inserted !== undefined) return;
  const existing = await tx.selectFrom('resource_id_ledger')
    .select('resource_type')
    .where('resource_id', '=', resourceId)
    .executeTakeFirst();
  if (existing?.resource_type === resourceType) return;
  invariant(`resource_id_ledger already reserved ${resourceId} as ${existing?.resource_type ?? 'missing'}`);
}

async function lockedCollection(tx: DatabaseTransaction, collectionId: string): Promise<CollectionFenceRow | undefined> {
  const row = await tx.selectFrom('collections').select([
    'id', 'resource_revision', 'content_revision', 'policy_revision', 'commit_ordinal',
    'publication_slug', 'published_at', 'visibility', 'payload_json',
  ]).where('id', '=', collectionId).where('deleted_at', 'is', null).forUpdate()
    .executeTakeFirst() as RawCollectionFenceRow | undefined;
  return row ? { ...row, commit_ordinal: BigInt(row.commit_ordinal) } : undefined;
}

export async function loadAuthoritativeAnnotationForUpdate(
  tx: DatabaseTransaction,
  collectionId: string,
  annotationId: string,
  requestingPrincipalId: string,
): Promise<AnnotationAuthorityRecord | null> {
  const row = await tx.selectFrom('annotations').selectAll()
    .where('collection_id', '=', collectionId).where('id', '=', annotationId)
    .where('deleted_at', 'is', null)
    .where((expression) => expression.or([
      expression('visibility', '!=', 'private'),
      expression('creator_principal_id', '=', requestingPrincipalId),
    ]))
    .forUpdate().executeTakeFirst();
  if (!row) return null;
  const payload = row.payload_json as unknown as Annotation;
  const structural = validators.validate('annotation', payload);
  if (!structural.valid || !payload.creator
    || payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.subject.type !== row.subject_type || payload.subject.id !== row.subject_id
    || payload.type !== row.type || (payload.format ?? null) !== row.format
    || canonicalJson(payload.value) !== canonicalJson(row.value_json)
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision
    || payload.createdAt !== formatUtcDateTime(row.created_at)
    || payload.updatedAt !== formatUtcDateTime(row.updated_at)
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled') {
    authorityInvariant('Annotation relational/payload authority mismatch');
  }
  const provenanceSourceNodeIds = payload.provenance?.sourceNodeIds ?? [];
  let resolvedSourceIds = new Set<string>();
  if (provenanceSourceNodeIds.length > 0) {
    const sourceRows = await tx.selectFrom('nodes').select('id')
      .where('collection_id', '=', collectionId)
      .where('id', 'in', [...provenanceSourceNodeIds])
      .where('deleted_at', 'is', null).execute();
    resolvedSourceIds = new Set(sourceRows.map((source) => source.id));
  }
  const semantic = validateAnnotationProvenance(payload, {
    operation: 'complete',
    contentOrigin: payload.provenance?.kind ?? 'human',
    collectionId,
    resolveNode: (nodeId) => resolvedSourceIds.has(nodeId) ? { collectionId } : undefined,
  });
  if (!semantic.valid || provenanceSourceNodeIds.some((nodeId) => !resolvedSourceIds.has(nodeId))) {
    authorityInvariant('Annotation provenance authority mismatch');
  }
  return {
    annotation: Object.freeze(structuredClone(payload)),
    creatorPrincipalId: row.creator_principal_id,
    deletedAt: row.deleted_at,
    provenanceSourceNodeIds: Object.freeze([...provenanceSourceNodeIds]),
  };
}

export async function loadAuthoritativeRelationForUpdate(
  tx: DatabaseTransaction,
  collectionId: string,
  relationId: string,
): Promise<RelationAuthorityRecord | null> {
  const row = await tx.selectFrom('relations').selectAll()
    .where('collection_id', '=', collectionId).where('id', '=', relationId)
    .where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
  if (!row) return null;
  const payload = row.payload_json as unknown as Relation;
  const structural = validators.validate('relation', payload);
  if (!structural.valid || payload.id !== row.id || payload.collectionId !== row.collection_id
    || payload.fromNodeId !== row.from_node_id || payload.toNodeId !== row.to_node_id
    || payload.type !== row.type || (payload.label ?? null) !== row.label
    || payload.visibility !== row.visibility || payload.revision !== row.resource_revision
    || payload.createdAt !== formatUtcDateTime(row.created_at)
    || payload.updatedAt !== formatUtcDateTime(row.updated_at)
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled') {
    authorityInvariant('Relation relational/payload authority mismatch');
  }
  return { relation: Object.freeze(structuredClone(payload)), deletedAt: row.deleted_at };
}

export async function planSidecarCanonicalMutation(
  tx: DatabaseTransaction,
  input: CanonicalMutationInput,
): Promise<CanonicalMutationPlan> {
  const kind = input.mutation.target.resourceKind;
  if (kind === 'annotation') {
    if (!['create', 'update', 'delete'].includes(input.mutation.action)
      || input.mutation.parentId !== null || !input.mutation.trustedFacts
      || (input.mutation.action !== 'delete' && !input.mutation.fields)
      || (input.mutation.action === 'delete' && (input.mutation.fields
        || input.mutation.deleteIntent?.scope !== 'single'))) {
      invariant('Annotation canonical port accepts only prepared create/update/single-delete mutations');
    }
    const existing = await tx.selectFrom('annotations').select(['id', 'resource_revision', 'deleted_at'])
      .where('id', '=', input.mutation.target.resourceId).executeTakeFirst();
    if (input.mutation.action === 'create' && existing) invariant('Annotation id is already committed');
    if (input.mutation.action === 'update'
      && (!existing || existing.deleted_at !== null
        || existing.resource_revision !== input.mutation.expectedResourceRevision)) {
      invariant('Annotation update expected revision no longer matches authority');
    }
    if (input.mutation.action === 'delete'
      && (!existing || existing.deleted_at !== null
        || existing.resource_revision !== input.mutation.expectedResourceRevision)) {
      invariant('Annotation delete expected revision no longer matches live authority');
    }
    return {
      operationId: input.operationId, collectionId: input.collectionId,
      mutation: {
        ...input.mutation, revisionEffects: {
          resource: true, content: true, policy: false, childrenOf: [],
        }, ...(input.mutation.action === 'delete'
          ? { deletePlan: { orderedResourceIds: [input.mutation.target.resourceId] } }
          : {}),
      },
    };
  }

  if (kind !== 'relation'
    || !['create', 'update', 'delete'].includes(input.mutation.action)
    || input.mutation.parentId !== null || !input.mutation.trustedFacts
    || (input.mutation.action !== 'delete' && !input.mutation.fields)
    || (input.mutation.action === 'delete'
      && (input.mutation.fields || input.mutation.deleteIntent?.scope !== 'single'))) {
    invariant('Relation canonical port accepts only prepared create/update/single-delete mutations');
  }
  const existing = await tx.selectFrom('relations').select(['id', 'resource_revision', 'deleted_at'])
    .where('id', '=', input.mutation.target.resourceId).executeTakeFirst();
  if (input.mutation.action === 'create' && existing) invariant('Relation id is already committed');
  if (input.mutation.action !== 'create'
    && (!existing || existing.deleted_at !== null
      || existing.resource_revision !== input.mutation.expectedResourceRevision)) {
    invariant(`Relation ${input.mutation.action} expected revision no longer matches live authority`);
  }
  if (input.mutation.fields) {
    const fields = input.mutation.fields.kindFields as unknown as RelationCreate;
    const endpoints = await tx.selectFrom('nodes').select('id')
      .where('collection_id', '=', input.collectionId)
      .where('id', 'in', [fields.fromNodeId, fields.toNodeId])
      .where('deleted_at', 'is', null).execute();
    if (fields.fromNodeId === fields.toNodeId || new Set(endpoints.map((row) => row.id)).size !== 2) {
      invariant('Relation endpoints changed after admission');
    }
  }
  return {
    operationId: input.operationId, collectionId: input.collectionId,
    mutation: {
      ...input.mutation, revisionEffects: {
        resource: true, content: true, policy: false, childrenOf: [],
      }, ...(input.mutation.action === 'delete'
        ? { deletePlan: { orderedResourceIds: [input.mutation.target.resourceId] } }
        : {}),
    },
  };
}

export async function applySidecarCanonicalMutation(
  tx: DatabaseTransaction,
  write: CanonicalResourceWrite,
  context: SidecarMutationWriteContext,
): Promise<void> {
  if (write.mutation.target.resourceKind === 'annotation') {
    await applyAnnotation(tx, write, context);
    return;
  }
  await applyRelation(tx, write, context);
}

async function applyAnnotation(
  tx: DatabaseTransaction,
  write: CanonicalResourceWrite,
  context: SidecarMutationWriteContext,
): Promise<void> {
  const { mutation, allocation } = write;
  const collection = await lockedCollection(tx, mutation.target.collectionId);
  if (!collection || collection.commit_ordinal + 1n !== allocation.commitOrdinal) {
    invariant('Annotation Collection fence changed while locked');
  }
  const currentForDelete = mutation.action === 'delete'
    ? await loadAuthoritativeAnnotationForUpdate(
      tx,
      mutation.target.collectionId,
      mutation.target.resourceId,
      String(mutation.trustedFacts?.creatorPrincipalId ?? ''),
    )
    : null;
  const fields = (mutation.action === 'delete'
    ? currentForDelete?.annotation
    : mutation.fields!.kindFields) as unknown as {
    readonly subject: { readonly type: 'collection' | 'node'; readonly id: string };
    readonly type: 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom';
    readonly format?: 'plain' | 'markdown' | 'html' | 'json';
    readonly value: unknown;
    readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
    readonly creator: Record<string, unknown>;
    readonly provenance?: Record<string, unknown>;
  };
  const creatorPrincipalId = mutation.trustedFacts?.creatorPrincipalId;
  const createdAt = mutation.action === 'delete'
    ? currentForDelete?.annotation.createdAt
    : mutation.trustedFacts?.createdAt;
  const updatedAt = mutation.action === 'delete'
    ? mutation.trustedFacts?.deletedAt
    : mutation.trustedFacts?.updatedAt;
  const purgeAfter = mutation.action === 'delete' ? mutation.trustedFacts?.purgeAfter : undefined;
  if (typeof creatorPrincipalId !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string'
    || (mutation.action === 'delete' && typeof purgeAfter !== 'string')) {
    invariant('Annotation trusted creator/time facts are missing');
  }
  const revision = allocation.resourceRevision;
  const contentRevision = allocation.contentRevision;
  if (!revision || !contentRevision) invariant('Annotation revisions are missing');
  const annotationId = mutation.target.resourceId;
  const livePayload = {
    subject: fields.subject, type: fields.type, ...(fields.format ? { format: fields.format } : {}),
    value: fields.value, visibility: fields.visibility, creator: fields.creator,
    ...(fields.provenance ? { provenance: fields.provenance } : {}),
    ...(mutation.action === 'delete'
      ? (currentForDelete?.annotation.extensions ? { extensions: currentForDelete.annotation.extensions } : {})
      : (Object.keys(mutation.fields!.extensions).length > 0 ? { extensions: mutation.fields!.extensions } : {})),
    id: annotationId, collectionId: mutation.target.collectionId,
    createdAt, updatedAt, revision,
  };
  const payload = mutation.action === 'delete' ? {
    ...livePayload,
    deletedAt: updatedAt,
    deletedCommitOrdinal: allocation.commitOrdinal.toString(),
    deletionOperationId: write.operationId,
    purgeAfter,
  } : livePayload;
  if (mutation.action === 'create') {
    await reserve(tx, annotationId, 'annotation');
    await context.faultInjector?.afterPhase?.({ phase: 'ledger', resourceId: annotationId });
    await tx.insertInto('annotations').values({
      id: annotationId, collection_id: mutation.target.collectionId,
      subject_type: fields.subject.type, subject_id: fields.subject.id,
      creator_principal_id: creatorPrincipalId, type: fields.type,
      format: fields.format ?? null,
      value_json: sql<unknown>`${canonicalJson(fields.value)}::jsonb`,
      visibility: fields.visibility, resource_revision: revision,
      created_at: new Date(createdAt), updated_at: new Date(updatedAt),
      deleted_at: null, deleted_commit_ordinal: null,
      payload_json: payload, payload_schema_version: 1, payload_authority_status: 'backfilled',
    }).execute();
  } else if (mutation.action === 'update') {
    const current = await loadAuthoritativeAnnotationForUpdate(
      tx,
      mutation.target.collectionId,
      annotationId,
      creatorPrincipalId,
    );
    const previousVisibility = mutation.trustedFacts?.previousVisibility;
    const publicRepresentationChanged = mutation.trustedFacts?.publicRepresentationChanged;
    const expectedPublicChange = current
      ? current.annotation.visibility !== 'private' || fields.visibility !== 'private'
      : false;
    if (!current || current.deletedAt !== null
      || current.annotation.revision !== mutation.expectedResourceRevision
      || current.creatorPrincipalId !== creatorPrincipalId
      || current.annotation.createdAt !== createdAt
      || current.annotation.subject.type !== fields.subject.type
      || current.annotation.subject.id !== fields.subject.id
      || current.annotation.type !== fields.type
      || canonicalJson(current.annotation.creator) !== canonicalJson(fields.creator)
      || previousVisibility !== current.annotation.visibility
      || typeof publicRepresentationChanged !== 'boolean'
      || publicRepresentationChanged !== expectedPublicChange) {
      invariant('Annotation update attempted to change immutable or untrusted authority facts');
    }
    const changed = await tx.updateTable('annotations').set({
      format: fields.format ?? null,
      value_json: sql<unknown>`${canonicalJson(fields.value)}::jsonb`,
      visibility: fields.visibility,
      resource_revision: revision,
      updated_at: new Date(updatedAt),
      payload_json: payload,
    }).where('id', '=', annotationId)
      .where('collection_id', '=', mutation.target.collectionId)
      .where('resource_revision', '=', mutation.expectedResourceRevision!)
      .where('deleted_at', 'is', null).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) invariant('Annotation update lost its expected revision race');
  } else {
    const previousVisibility = mutation.trustedFacts?.previousVisibility;
    if (!currentForDelete || currentForDelete.deletedAt !== null
      || currentForDelete.annotation.revision !== mutation.expectedResourceRevision
      || currentForDelete.creatorPrincipalId !== creatorPrincipalId
      || previousVisibility !== currentForDelete.annotation.visibility
      || mutation.deletePlan?.orderedResourceIds.length !== 1
      || mutation.deletePlan.orderedResourceIds[0] !== annotationId) {
      invariant('Annotation delete attempted to change immutable authority or membership facts');
    }
    const changed = await tx.updateTable('annotations').set({
      resource_revision: revision,
      updated_at: new Date(updatedAt),
      deleted_at: new Date(updatedAt),
      deleted_commit_ordinal: allocation.commitOrdinal,
      payload_json: payload,
    }).where('id', '=', annotationId)
      .where('collection_id', '=', mutation.target.collectionId)
      .where('resource_revision', '=', mutation.expectedResourceRevision!)
      .where('deleted_at', 'is', null).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) invariant('Annotation delete lost its expected revision race');
  }

  const collectionPayload = collection.payload_json;
  if (!collectionPayload) invariant('Collection canonical payload is missing');
  const nextCollectionPayload = { ...collectionPayload,
    contentRevision, commitOrdinal: allocation.commitOrdinal.toString(), updatedAt };
  const updated = await tx.updateTable('collections').set({
    content_revision: contentRevision, commit_ordinal: allocation.commitOrdinal,
    updated_at: new Date(updatedAt), payload_json: nextCollectionPayload,
  }).where('id', '=', collection.id).where('commit_ordinal', '=', collection.commit_ordinal).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) invariant('Annotation Collection fence update failed');
  await context.faultInjector?.afterPhase?.({ phase: 'resource', resourceId: annotationId });

  await tx.insertInto('resource_revisions').values({ collection_id: collection.id,
    resource_id: annotationId, revision, ordinal: allocation.commitOrdinal,
    created_at: new Date(mutation.action === 'create' ? createdAt : updatedAt) }).execute();
  await tx.insertInto('content_revisions').values({ collection_id: collection.id,
    revision: contentRevision, ordinal: allocation.commitOrdinal,
    created_at: new Date(mutation.action === 'create' ? createdAt : updatedAt) }).execute();
  await context.faultInjector?.afterPhase?.({ phase: 'revision', resourceId: annotationId });

  const readBack = await tx.selectFrom('annotations').selectAll().where('id', '=', annotationId).executeTakeFirst();
  if (!readBack || readBack.collection_id !== payload.collectionId
    || readBack.subject_type !== payload.subject.type || readBack.subject_id !== payload.subject.id
    || readBack.creator_principal_id !== creatorPrincipalId
    || readBack.type !== payload.type || readBack.format !== (fields.format ?? null)
    || canonicalJson(readBack.value_json) !== canonicalJson(fields.value)
    || readBack.visibility !== payload.visibility
    || readBack.resource_revision !== payload.revision
    || readBack.created_at.getTime() !== new Date(createdAt).getTime()
    || readBack.updated_at.getTime() !== new Date(updatedAt).getTime()
    || (mutation.action === 'delete'
      ? !(readBack.deleted_at instanceof Date)
        || BigInt(readBack.deleted_commit_ordinal ?? 0) !== allocation.commitOrdinal
      : readBack.deleted_at !== null || readBack.deleted_commit_ordinal !== null)
    || readBack.payload_schema_version !== 1 || readBack.payload_authority_status !== 'backfilled'
    || canonicalJson(readBack.payload_json) !== canonicalJson(payload)) {
    invariant('Annotation relational/payload authority read-back mismatch');
  }
  const collectionReadBack = await tx.selectFrom('collections').select([
    'content_revision', 'commit_ordinal', 'updated_at', 'payload_json',
  ]).where('id', '=', collection.id).executeTakeFirst();
  if (!collectionReadBack || collectionReadBack.content_revision !== contentRevision
    || BigInt(collectionReadBack.commit_ordinal) !== allocation.commitOrdinal
    || collectionReadBack.updated_at.getTime() !== new Date(updatedAt).getTime()
    || canonicalJson(collectionReadBack.payload_json) !== canonicalJson(nextCollectionPayload)) {
    invariant('Annotation Collection relational/payload authority read-back mismatch');
  }
}

async function applyRelation(
  tx: DatabaseTransaction,
  write: CanonicalResourceWrite,
  context: SidecarMutationWriteContext,
): Promise<void> {
  const { mutation, allocation } = write;
  const collection = await lockedCollection(tx, mutation.target.collectionId);
  if (!collection || collection.commit_ordinal + 1n !== allocation.commitOrdinal) {
    invariant('Relation Collection fence changed while locked');
  }
  const currentForWrite = mutation.action === 'create' ? null
    : await loadAuthoritativeRelationForUpdate(tx, mutation.target.collectionId,
      mutation.target.resourceId);
  const fields = (mutation.action === 'delete' ? currentForWrite?.relation
    : mutation.fields!.kindFields) as RelationCreate;
  const createdAt = mutation.action === 'delete' ? currentForWrite?.relation.createdAt
    : mutation.trustedFacts?.createdAt;
  const updatedAt = mutation.action === 'delete' ? mutation.trustedFacts?.deletedAt
    : mutation.trustedFacts?.updatedAt;
  const purgeAfter = mutation.action === 'delete' ? mutation.trustedFacts?.purgeAfter : undefined;
  const revision = allocation.resourceRevision;
  const contentRevision = allocation.contentRevision;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string' || !revision || !contentRevision
    || (mutation.action === 'delete' && typeof purgeAfter !== 'string')) {
    invariant('Relation trusted time/revision facts are missing');
  }
  const relationId = mutation.target.resourceId;
  const livePayload: Relation = {
    id: relationId, collectionId: mutation.target.collectionId, type: fields.type,
    fromNodeId: fields.fromNodeId, toNodeId: fields.toNodeId,
    ...(fields.label === undefined ? {} : { label: fields.label }),
    visibility: fields.visibility, createdAt, updatedAt, revision,
    ...(mutation.action === 'delete'
      ? (currentForWrite?.relation.extensions ? { extensions: currentForWrite.relation.extensions } : {})
      : (Object.keys(mutation.fields!.extensions).length > 0
        ? { extensions: mutation.fields!.extensions } : {})),
  } as Relation;
  const payload = mutation.action === 'delete' ? { ...livePayload, deletedAt: updatedAt,
    deletedCommitOrdinal: allocation.commitOrdinal.toString(), deletionOperationId: write.operationId,
    purgeAfter } : livePayload;
  if (mutation.action !== 'delete' && !validators.validate('relation', livePayload).valid) {
    invariant('Relation canonical payload is invalid');
  }

  if (mutation.action === 'create') {
    await reserve(tx, relationId, 'relation');
    await context.faultInjector?.afterPhase?.({ phase: 'ledger', resourceId: relationId });
    try { await tx.insertInto('relations').values({
      id: relationId, collection_id: mutation.target.collectionId,
      from_node_id: fields.fromNodeId, to_node_id: fields.toNodeId,
      type: fields.type, label: fields.label ?? null, visibility: fields.visibility,
      resource_revision: revision, created_at: new Date(createdAt), updated_at: new Date(updatedAt),
      deleted_at: null, deleted_commit_ordinal: null,
      payload_json: payload as unknown as Record<string, unknown>,
      payload_schema_version: 1, payload_authority_status: 'backfilled',
    }).execute(); } catch (error) {
      if ((error as { constraint?: string }).constraint === 'relations_live_semantic_edge_uidx') {
        invariant('Relation semantic edge was concurrently committed');
      }
      throw error;
    }
  } else if (mutation.action === 'update') {
    const previousVisibility = mutation.trustedFacts?.previousVisibility;
    const publicRepresentationChanged = mutation.trustedFacts?.publicRepresentationChanged;
    const expectedPublicChange = currentForWrite
      ? currentForWrite.relation.visibility !== 'private' || fields.visibility !== 'private' : false;
    if (!currentForWrite || currentForWrite.relation.revision !== mutation.expectedResourceRevision
      || currentForWrite.relation.createdAt !== createdAt
      || currentForWrite.relation.fromNodeId !== fields.fromNodeId
      || currentForWrite.relation.toNodeId !== fields.toNodeId
      || previousVisibility !== currentForWrite.relation.visibility
      || typeof publicRepresentationChanged !== 'boolean'
      || publicRepresentationChanged !== expectedPublicChange) {
      invariant('Relation update attempted to change immutable or untrusted authority facts');
    }
    try { const changed = await tx.updateTable('relations').set({ type: fields.type,
      label: fields.label ?? null, visibility: fields.visibility, resource_revision: revision,
      updated_at: new Date(updatedAt), payload_json: payload as Record<string, unknown> })
      .where('id', '=', relationId).where('collection_id', '=', mutation.target.collectionId)
      .where('resource_revision', '=', mutation.expectedResourceRevision!)
      .where('deleted_at', 'is', null).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) invariant('Relation update lost its expected revision race'); }
    catch (error) {
      if ((error as { constraint?: string }).constraint === 'relations_live_semantic_edge_uidx') {
        invariant('Relation semantic edge was concurrently committed');
      }
      throw error;
    }
  } else {
    if (!currentForWrite || currentForWrite.relation.revision !== mutation.expectedResourceRevision
      || mutation.trustedFacts?.previousVisibility !== currentForWrite.relation.visibility
      || mutation.deletePlan?.orderedResourceIds.length !== 1
      || mutation.deletePlan.orderedResourceIds[0] !== relationId) {
      invariant('Relation delete attempted to change immutable authority or membership facts');
    }
    const changed = await tx.updateTable('relations').set({ resource_revision: revision,
      updated_at: new Date(updatedAt), deleted_at: new Date(updatedAt),
      deleted_commit_ordinal: allocation.commitOrdinal,
      payload_json: payload as Record<string, unknown> })
      .where('id', '=', relationId).where('collection_id', '=', mutation.target.collectionId)
      .where('resource_revision', '=', mutation.expectedResourceRevision!)
      .where('deleted_at', 'is', null).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) invariant('Relation delete lost its expected revision race');
  }

  const collectionPayload = collection.payload_json;
  if (!collectionPayload) invariant('Collection canonical payload is missing');
  const nextCollectionPayload = { ...collectionPayload, contentRevision,
    commitOrdinal: allocation.commitOrdinal.toString(), updatedAt };
  const updated = await tx.updateTable('collections').set({ content_revision: contentRevision,
    commit_ordinal: allocation.commitOrdinal, updated_at: new Date(updatedAt), payload_json: nextCollectionPayload })
    .where('id', '=', collection.id).where('commit_ordinal', '=', collection.commit_ordinal).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) invariant('Relation Collection fence update failed');
  await context.faultInjector?.afterPhase?.({ phase: 'resource', resourceId: relationId });

  await tx.insertInto('resource_revisions').values({ collection_id: collection.id,
    resource_id: relationId, revision, ordinal: allocation.commitOrdinal,
    created_at: new Date(mutation.action === 'create' ? createdAt : updatedAt) }).execute();
  await tx.insertInto('content_revisions').values({ collection_id: collection.id,
    revision: contentRevision, ordinal: allocation.commitOrdinal,
    created_at: new Date(mutation.action === 'create' ? createdAt : updatedAt) }).execute();
  await context.faultInjector?.afterPhase?.({ phase: 'revision', resourceId: relationId });

  const row = await tx.selectFrom('relations').selectAll().where('id', '=', relationId).executeTakeFirst();
  if (!row || row.collection_id !== livePayload.collectionId || row.from_node_id !== livePayload.fromNodeId
    || row.to_node_id !== livePayload.toNodeId || row.type !== livePayload.type
    || row.label !== (livePayload.label ?? null) || row.visibility !== livePayload.visibility
    || row.resource_revision !== livePayload.revision
    || row.created_at.getTime() !== new Date(livePayload.createdAt).getTime()
    || row.updated_at.getTime() !== new Date(livePayload.updatedAt).getTime()
    || (mutation.action === 'delete'
      ? !(row.deleted_at instanceof Date)
        || BigInt(row.deleted_commit_ordinal ?? 0) !== allocation.commitOrdinal
      : row.deleted_at !== null || row.deleted_commit_ordinal !== null)
    || row.payload_schema_version !== 1 || row.payload_authority_status !== 'backfilled'
    || canonicalJson(row.payload_json) !== canonicalJson(payload)) {
    authorityInvariant('Relation relational/payload authority read-back mismatch');
  }
}

export async function appendSidecarDomainEvent(
  tx: DatabaseTransaction,
  event: CanonicalDomainEvent,
  context: SidecarMutationWriteContext,
): Promise<void> {
  const append = event.aggregateType === 'annotation'
    ? appendAnnotationDomainEvent
    : appendRelationDomainEvent;
  await append(tx, event, context);
  await appendReportSourceInvalidation(context.reportSourceInvalidation, tx, event);
}

async function appendAnnotationDomainEvent(
  tx: DatabaseTransaction,
  event: CanonicalDomainEvent,
  context: SidecarMutationWriteContext,
): Promise<void> {
  const annotation = await tx.selectFrom('annotations').selectAll()
    .where('id', '=', event.aggregateId).executeTakeFirst();
  const collection = await lockedCollection(tx, event.collectionId);
  if (!annotation || !collection) invariant('Annotation outbox authority is missing');
  const isUpdate = event.eventType === 'resource.update';
  const isDelete = event.eventType === 'resource.delete';
  const facts = isUpdate ? context.updateFacts : undefined;
  if (isUpdate && !facts) invariant('Annotation update outbox facts are missing');
  const eventType = isDelete ? ANNOTATION_DELETED_EVENT_TYPE
    : isUpdate ? ANNOTATION_UPDATED_EVENT_TYPE : ANNOTATION_CREATED_EVENT_TYPE;
  const eventVersion = isDelete ? ANNOTATION_DELETED_EVENT_VERSION
    : isUpdate ? ANNOTATION_UPDATED_EVENT_VERSION : ANNOTATION_CREATED_EVENT_VERSION;
  const handlerName = isDelete ? ANNOTATION_DELETED_HANDLER_NAME
    : isUpdate ? ANNOTATION_UPDATED_HANDLER_NAME : ANNOTATION_CREATED_HANDLER_NAME;
  const outboxId = (context.outboxIdGenerator ?? generateOutboxId)();
  const mutationPayload = isDelete ? {
    affectedCount: 1,
    annotationId: annotation.id,
    collectionId: event.collectionId,
    contentRevision: collection.content_revision,
    deletedAt: formatUtcDateTime(annotation.deleted_at!),
    deleteRevision: annotation.resource_revision,
    operationId: event.operationId,
    subjectId: annotation.subject_id,
    subjectType: annotation.subject_type,
    visibility: annotation.visibility,
  } : {
    collectionId: event.collectionId, annotationId: annotation.id,
    subjectType: annotation.subject_type, subjectId: annotation.subject_id,
    visibility: annotation.visibility, resourceRevision: annotation.resource_revision,
    contentRevision: collection.content_revision,
    ...(facts ? {
      previousVisibility: facts.previousVisibility,
      publicRepresentationChanged: facts.publicRepresentationChanged,
    } : {}),
  };
  if (isUpdate) assertAnnotationUpdatedPayload(mutationPayload);
  if (isDelete) assertAnnotationDeletedPayload(mutationPayload);
  await reserve(tx, event.domainEventId, 'domain-event');
  await reserve(tx, outboxId, 'outbox');
  await tx.insertInto('outbox_events').values({
    outbox_id: outboxId, domain_event_id: event.domainEventId,
    event_type: eventType, event_version: eventVersion,
    handler_name: handlerName, handler_mode: 'projection_latest_only',
    aggregate_scope: event.collectionId, aggregate_revision: annotation.resource_revision,
    commit_ordinal: event.commitOrdinal, payload_json: mutationPayload,
    state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
    locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
    aggregate_type: 'annotation', aggregate_id: annotation.id,
    occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
  }).execute();
  const shouldPurge = isDelete
    ? annotation.visibility !== 'private'
    : facts
      ? facts.publicRepresentationChanged
      : annotation.visibility !== 'private';
  if (shouldPurge && collection.publication_slug && collection.published_at) {
    const purgeId = (context.outboxIdGenerator ?? generateOutboxId)();
    await reserve(tx, purgeId, 'outbox');
    await tx.insertInto('outbox_events').values({
      outbox_id: purgeId, domain_event_id: event.domainEventId,
      event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME, handler_mode: 'delivery_each_event',
      aggregate_scope: event.collectionId, aggregate_revision: collection.content_revision,
      commit_ordinal: event.commitOrdinal, payload_json: {
        collectionId: event.collectionId, contentRevision: collection.content_revision,
        policyRevision: collection.policy_revision, publicationSlug: collection.publication_slug,
        sourceEventType: eventType,
        sourceEventVersion: eventVersion,
        visibility: collection.visibility,
      }, state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
      locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
      aggregate_type: 'collection', aggregate_id: event.collectionId,
      occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null,
    }).execute();
  }
}

async function appendRelationDomainEvent(
  tx: DatabaseTransaction,
  event: CanonicalDomainEvent,
  context: SidecarMutationWriteContext,
): Promise<void> {
  const relation = await tx.selectFrom('relations').selectAll()
    .where('id', '=', event.aggregateId).executeTakeFirst();
  const collection = await lockedCollection(tx, event.collectionId);
  if (!relation || !collection) invariant('Relation outbox authority is missing');
  const isUpdate = event.eventType === 'resource.update';
  const isDelete = event.eventType === 'resource.delete';
  const facts = isUpdate ? context.updateFacts : undefined;
  if (isUpdate && !facts) invariant('Relation update outbox facts are missing');
  const eventType = isDelete ? RELATION_DELETED_EVENT_TYPE
    : isUpdate ? RELATION_UPDATED_EVENT_TYPE : RELATION_CREATED_EVENT_TYPE;
  const eventVersion = isDelete ? RELATION_DELETED_EVENT_VERSION
    : isUpdate ? RELATION_UPDATED_EVENT_VERSION : RELATION_CREATED_EVENT_VERSION;
  const handlerName = isDelete ? RELATION_DELETED_HANDLER_NAME
    : isUpdate ? RELATION_UPDATED_HANDLER_NAME : RELATION_CREATED_HANDLER_NAME;
  const payload = isDelete ? { affectedCount: 1, collectionId: event.collectionId,
    relationId: relation.id, fromNodeId: relation.from_node_id, toNodeId: relation.to_node_id,
    visibility: relation.visibility, contentRevision: collection.content_revision,
    deletedAt: formatUtcDateTime(relation.deleted_at!), deleteRevision: relation.resource_revision,
    operationId: event.operationId } : { collectionId: event.collectionId, relationId: relation.id,
    fromNodeId: relation.from_node_id, toNodeId: relation.to_node_id, type: relation.type,
    visibility: relation.visibility, resourceRevision: relation.resource_revision,
    contentRevision: collection.content_revision,
    ...(facts ? { previousVisibility: facts.previousVisibility,
      publicRepresentationChanged: facts.publicRepresentationChanged } : {}) };
  await reserve(tx, event.domainEventId, 'domain-event');
  const outboxId = (context.outboxIdGenerator ?? generateOutboxId)();
  await reserve(tx, outboxId, 'outbox');
  await tx.insertInto('outbox_events').values({ outbox_id: outboxId,
    domain_event_id: event.domainEventId, event_type: eventType,
    event_version: eventVersion, handler_name: handlerName,
    handler_mode: 'projection_latest_only', aggregate_scope: event.collectionId,
    aggregate_revision: relation.resource_revision, commit_ordinal: event.commitOrdinal,
    payload_json: payload, state: 'pending', attempt_count: 0,
    available_at: sql<Date>`current_timestamp`, locked_until: null, lease_generation: 0n,
    completed_at: null, last_error: null, aggregate_type: 'relation', aggregate_id: relation.id,
    occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null }).execute();
  const shouldPurge = isDelete ? relation.visibility !== 'private'
    : facts ? facts.publicRepresentationChanged : relation.visibility !== 'private';
  if (shouldPurge && collection.publication_slug && collection.published_at) {
    const purgeId = (context.outboxIdGenerator ?? generateOutboxId)();
    await reserve(tx, purgeId, 'outbox');
    await tx.insertInto('outbox_events').values({ outbox_id: purgeId,
      domain_event_id: event.domainEventId, event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME, handler_mode: 'delivery_each_event',
      aggregate_scope: event.collectionId, aggregate_revision: collection.content_revision,
      commit_ordinal: event.commitOrdinal, payload_json: { collectionId: event.collectionId,
        contentRevision: collection.content_revision, policyRevision: collection.policy_revision,
        publicationSlug: collection.publication_slug, sourceEventType: eventType,
        sourceEventVersion: eventVersion, visibility: collection.visibility },
      state: 'pending', attempt_count: 0, available_at: sql<Date>`current_timestamp`,
      locked_until: null, lease_generation: 0n, completed_at: null, last_error: null,
      aggregate_type: 'collection', aggregate_id: event.collectionId,
      occurred_at: sql<Date>`current_timestamp`, dead_lettered_at: null }).execute();
  }
}
