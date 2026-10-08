import type { Annotation } from '@know-n/colp/types';
import type { MembershipRole } from '../../access-policy/index.js';
import {
  assertCanonicalCommandId,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  formatUtcDateTime,
  generateOpaqueId,
  type CanonicalMutationInput,
  type JsonObject,
} from '../domain/index.js';
import {
  NODE_DELETION_PURGE_RETENTION_MS,
  type DeletionReceiptSnapshot,
} from './delete-collection-node.js';
import type {
  AnnotationIfMatchEvidence,
  AnnotationMutationPorts,
} from './update-annotation.js';

export const DELETE_ANNOTATION_CONTRACT_VERSION = '1.0.0';
export const ANNOTATION_DELETED_EVENT_TYPE = 'annotation.deleted';
export const ANNOTATION_DELETED_EVENT_VERSION = 1;
export const ANNOTATION_DELETED_HANDLER_NAME = 'annotation_deleted_projection';

export type AnnotationDeleteErrorCode =
  | 'invalid_annotation_input'
  | 'annotation_not_found'
  | 'annotation_precondition_required'
  | 'invalid_annotation_precondition'
  | 'annotation_precondition_failed';

export class AnnotationDeleteError extends Error {
  constructor(
    readonly code: AnnotationDeleteErrorCode,
    message: string,
    readonly currentEtag?: string,
  ) {
    super(message);
    this.name = 'AnnotationDeleteError';
  }
}

export interface DeleteAnnotationInput {
  readonly actor: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly principalType: 'account';
  };
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope?: string;
  };
  readonly collectionId: string;
  readonly annotationId: string;
  readonly precondition: AnnotationIfMatchEvidence;
  readonly operationId?: string;
}

export interface AnnotationDeletionReceiptSnapshot extends Omit<DeletionReceiptSnapshot, 'resourceType'> {
  readonly resourceType: 'annotation';
  readonly scope: 'single';
}

export interface AnnotationDeleteFenceSnapshot {
  readonly contentRevision: string;
  readonly policyRevision: string;
}

export type DeleteAnnotationResult =
  | {
      readonly kind: 'deleted';
      readonly receipt: AnnotationDeletionReceiptSnapshot;
      readonly fence: AnnotationDeleteFenceSnapshot;
      readonly operationId: string;
      readonly commitOrdinal: bigint;
    }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
      readonly contractVersion: string;
      readonly targetIdentity?: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

interface ValidatedDeleteAnnotationInput extends Omit<DeleteAnnotationInput, 'command' | 'precondition'> {
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly precondition: { readonly entityTag: string; readonly expectedRevision: string };
}

const revisionPattern = /^[A-Za-z0-9._~-]{1,128}$/u;

export function deleteAnnotationCommandScope(collectionId: string, annotationId: string): string {
  return `collection:${collectionId}:annotation:${annotationId}:delete`;
}

export async function deleteAnnotation(
  ports: AnnotationMutationPorts,
  input: DeleteAnnotationInput,
): Promise<DeleteAnnotationResult> {
  const validated = validateInput(input);
  const binding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const collection = await ports.collections.lockForUpdate(validated.collectionId);
  if (!collection || collection.deletedAt !== null) conceal();
  const facts = await ports.accessPolicy.loadCollectionFacts({
    collectionId: validated.collectionId,
    actorSubjectId: validated.actor.subjectId,
  });
  if (!facts || facts.deleted) conceal();

  const authority = await ports.annotations.loadAuthoritativeForUpdate(
    validated.collectionId,
    validated.annotationId,
    validated.actor.principalId,
  );
  if (!authority || authority.deletedAt !== null) conceal();
  const current = authority.annotation;
  if (current.id !== validated.annotationId || current.collectionId !== validated.collectionId) conceal();

  const role: MembershipRole | null = validated.actor.subjectId === facts.ownerSubjectId
    ? 'owner' : facts.membershipRole;
  authorize(current.visibility, role, authority.creatorPrincipalId === validated.actor.principalId);
  if (current.revision !== validated.precondition.expectedRevision) {
    throw new AnnotationDeleteError(
      'annotation_precondition_failed',
      'Annotation changed before this delete was applied.',
      `"${current.revision}"`,
    );
  }

  const now = await ports.clock.now();
  const deletedAt = formatUtcDateTime(now);
  const purgeAfter = formatUtcDateTime(new Date(now.getTime() + NODE_DELETION_PURGE_RETENTION_MS));
  const operationId = validated.operationId ?? generateOpaqueId();
  const canonicalInput: CanonicalMutationInput = {
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'delete',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.annotationId,
        resourceKind: 'annotation',
      },
      parentId: null,
      expectedResourceRevision: current.revision,
      deleteIntent: { scope: 'single' },
      trustedFacts: {
        creatorPrincipalId: authority.creatorPrincipalId,
        previousVisibility: current.visibility,
        deletedAt,
        purgeAfter,
      },
    },
  };
  const mutation = await ports.canonical.execute(canonicalInput);
  const deleteRevision = mutation.allocation.resourceRevision;
  const contentRevision = mutation.allocation.contentRevision;
  if (!deleteRevision || !contentRevision) {
    throw new AnnotationDeleteError('invalid_annotation_input', 'Canonical delete did not allocate revisions.');
  }
  const deletedMembers = mutation.allocation.deletedResourceRevisions ?? {};
  if (Object.keys(deletedMembers).length !== 1 || deletedMembers[validated.annotationId] !== deleteRevision) {
    throw new AnnotationDeleteError('invalid_annotation_input', 'Canonical delete membership was not authoritative.');
  }
  const receipt: AnnotationDeletionReceiptSnapshot = {
    resourceType: 'annotation',
    targetId: validated.annotationId,
    collectionId: validated.collectionId,
    scope: 'single',
    deletedAt,
    deleteRevision,
    operationId,
    affectedCount: 1,
    purgeAfter,
  };
  const fence = {
    contentRevision,
    policyRevision: mutation.allocation.policyRevision ?? collection.policyRevision,
  };
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult(receipt, fence));
  return { kind: 'deleted', receipt, fence, operationId, commitOrdinal: mutation.allocation.commitOrdinal };
}

function validateInput(input: DeleteAnnotationInput): ValidatedDeleteAnnotationInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command) {
    throw new AnnotationDeleteError('invalid_annotation_input', 'Annotation delete input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.collectionId,
    input.annotationId, input.command.fingerprint]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AnnotationDeleteError('invalid_annotation_input', 'Annotation delete identity fields are required.');
    }
  }
  if (input.actor.principalType !== 'account') {
    throw new AnnotationDeleteError('invalid_annotation_input', 'Annotation delete requires an account actor.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new AnnotationDeleteError('invalid_annotation_input', 'commandId must be a canonical UUID v4.'); }
  return {
    ...input,
    command: { commandId, fingerprint: input.command.fingerprint,
      commandScope: input.command.commandScope?.trim()
        || deleteAnnotationCommandScope(input.collectionId, input.annotationId) },
    precondition: validatePrecondition(input.precondition),
  };
}

function validatePrecondition(value: AnnotationIfMatchEvidence | undefined) {
  if (!value || value.kind === 'missing') {
    throw new AnnotationDeleteError('annotation_precondition_required', 'A single strong If-Match is required.');
  }
  if (value.kind !== 'single-strong-if-match') {
    throw new AnnotationDeleteError('invalid_annotation_precondition', 'Duplicate If-Match fields are forbidden.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'entityTag' || keys[1] !== 'expectedRevision' || keys[2] !== 'kind'
    || !revisionPattern.test(value.expectedRevision) || value.entityTag !== `"${value.expectedRevision}"`) {
    throw new AnnotationDeleteError(
      'invalid_annotation_precondition',
      'If-Match must contain exactly one well-formed strong entity-tag.',
    );
  }
  return { entityTag: value.entityTag, expectedRevision: value.expectedRevision };
}

function authorize(visibility: Annotation['visibility'], role: MembershipRole | null, isCreator: boolean): void {
  if (role === null || (visibility === 'private' && !isCreator)
    || (visibility !== 'private' && !isCreator && role !== 'owner' && role !== 'editor')) conceal();
}

function conceal(): never {
  throw new AnnotationDeleteError('annotation_not_found', 'Annotation was not found.');
}

function productResult(
  receipt: AnnotationDeletionReceiptSnapshot,
  fence: AnnotationDeleteFenceSnapshot,
): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify({ receipt, fence }), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      location: `/api/v1/collections/${receipt.collectionId}/annotations/${receipt.targetId}`,
      etag: `"${receipt.deleteRevision}"`,
    },
    mediaType: 'application/json',
    contractVersion: DELETE_ANNOTATION_CONTRACT_VERSION,
    targetIdentity: receipt.targetId,
  };
}

function mapClaim(
  claim: Exclude<Awaited<ReturnType<AnnotationMutationPorts['receipts']['claim']>>, { kind: 'claimed' }>,
): DeleteAnnotationResult {
  switch (claim.kind) {
    case 'replay': return { kind: 'replay', status: claim.result.status, body: claim.result.body,
      stableHeaders: claim.result.stableHeaders, mediaType: claim.result.mediaType,
      contractVersion: claim.result.contractVersion, targetIdentity: claim.result.targetIdentity };
    case 'in_progress': return { kind: 'in_progress', retryAfterSeconds: claim.retryAfterSeconds };
    case 'reused': return { kind: 'reused' };
    case 'expired': return { kind: 'expired', resultDigest: claim.resultDigest };
    default: { const exhaustive: never = claim; return exhaustive; }
  }
}

export interface AnnotationDeletedPayload extends JsonObject {
  readonly affectedCount: 1;
  readonly annotationId: string;
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly deletedAt: string;
  readonly deleteRevision: string;
  readonly operationId: string;
  readonly subjectId: string;
  readonly subjectType: 'collection' | 'node';
  readonly visibility: Annotation['visibility'];
}

/** Producer-side closed annotation.deleted@1 payload validation. */
export function assertAnnotationDeletedPayload(value: unknown): asserts value is AnnotationDeletedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnnotationDeleteError('invalid_annotation_input', 'annotation.deleted payload must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expected = ['affectedCount', 'annotationId', 'collectionId', 'contentRevision', 'deletedAt',
    'deleteRevision', 'operationId', 'subjectId', 'subjectType', 'visibility'].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || record.affectedCount !== 1
    || typeof record.deletedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(record.deletedAt)
    || !Number.isFinite(Date.parse(record.deletedAt))
    || !['collection', 'node'].includes(record.subjectType as string)
    || !['public', 'unlisted', 'protected', 'private'].includes(record.visibility as string)
    || expected.filter((key) => !['affectedCount', 'subjectType', 'visibility'].includes(key))
      .some((key) => typeof record[key] !== 'string' || (record[key] as string).length === 0)) {
    throw new AnnotationDeleteError('invalid_annotation_input', 'annotation.deleted payload must be closed and valid.');
  }
}
