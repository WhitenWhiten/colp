import type { Relation } from '@know-n/colp/types';
import type { MembershipRole } from '../../access-policy/index.js';
import { assertCanonicalCommandId, type ProductCommandResult } from '../../commands/index.js';
import { formatUtcDateTime, generateOpaqueId, type JsonObject } from '../domain/index.js';
import { NODE_DELETION_PURGE_RETENTION_MS, type DeletionReceiptSnapshot } from './delete-collection-node.js';
import {
  RelationUpdateError,
  validateRelationPrecondition,
  type RelationIfMatchEvidence,
  type RelationMutationPorts,
} from './update-relation.js';

export const DELETE_RELATION_CONTRACT_VERSION = '1.0.0';
export const RELATION_DELETED_EVENT_TYPE = 'relation.deleted';
export const RELATION_DELETED_EVENT_VERSION = 1;
export const RELATION_DELETED_HANDLER_NAME = 'relation_deleted_projection';

export type RelationDeleteErrorCode =
  | 'invalid_relation_input' | 'relation_not_found' | 'relation_precondition_required'
  | 'invalid_relation_precondition' | 'relation_precondition_failed' | 'insufficient_relation_permission';

export class RelationDeleteError extends Error {
  constructor(readonly code: RelationDeleteErrorCode, message: string, readonly currentEtag?: string) {
    super(message); this.name = 'RelationDeleteError';
  }
}

export interface DeleteRelationInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string; readonly principalType: 'account' };
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly collectionId: string; readonly relationId: string;
  readonly precondition: RelationIfMatchEvidence; readonly operationId?: string;
}

export interface RelationDeletionReceiptSnapshot extends Omit<DeletionReceiptSnapshot, 'resourceType'> {
  readonly resourceType: 'relation'; readonly scope: 'single';
}

export type DeleteRelationResult =
  | { readonly kind: 'deleted'; readonly receipt: RelationDeletionReceiptSnapshot;
      readonly fence: { readonly contentRevision: string; readonly policyRevision: string };
      readonly operationId: string; readonly commitOrdinal: bigint }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export function deleteRelationCommandScope(collectionId: string, relationId: string): string {
  return `collection:${collectionId}:relation:${relationId}:delete`;
}

export async function deleteRelation(
  ports: RelationMutationPorts,
  input: DeleteRelationInput,
): Promise<DeleteRelationResult> {
  const validated = validateInput(input);
  const binding = { principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope, commandId: validated.command.commandId };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const collection = await ports.collections.lockForUpdate(validated.collectionId);
  if (!collection || collection.deletedAt !== null) conceal();
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId: validated.collectionId,
    actorSubjectId: validated.actor.subjectId });
  if (!facts || facts.deleted) conceal();
  const role: MembershipRole | null = validated.actor.subjectId === facts.ownerSubjectId
    ? 'owner' : facts.membershipRole;
  if (role === null) conceal();
  if (role === 'viewer') throw new RelationDeleteError('insufficient_relation_permission',
    'Relation delete requires editor permission.');
  const authority = await ports.relations.loadAuthoritativeForUpdate(validated.collectionId, validated.relationId);
  if (!authority || authority.deletedAt !== null) conceal();
  const current = authority.relation;
  if (current.id !== validated.relationId || current.collectionId !== validated.collectionId) conceal();
  if (current.revision !== validated.precondition.expectedRevision) {
    throw new RelationDeleteError('relation_precondition_failed',
      'Relation changed before this delete was applied.', `"${current.revision}"`);
  }
  const now = await ports.clock.now(); const deletedAt = formatUtcDateTime(now);
  const purgeAfter = formatUtcDateTime(new Date(now.getTime() + NODE_DELETION_PURGE_RETENTION_MS));
  const operationId = validated.operationId ?? generateOpaqueId();
  const mutation = await ports.canonical.execute({ operationId, collectionId: validated.collectionId,
    actor: { principalId: validated.actor.principalId, principalType: validated.actor.principalType },
    mutation: { action: 'delete', target: { collectionId: validated.collectionId,
      resourceId: validated.relationId, resourceKind: 'relation' }, parentId: null,
      expectedResourceRevision: current.revision, deleteIntent: { scope: 'single' },
      trustedFacts: { createdAt: current.createdAt, previousVisibility: current.visibility,
        deletedAt, purgeAfter } } });
  const deleteRevision = mutation.allocation.resourceRevision;
  const contentRevision = mutation.allocation.contentRevision;
  if (!deleteRevision || !contentRevision
    || mutation.allocation.deletedResourceRevisions?.[validated.relationId] !== deleteRevision) {
    throw new RelationDeleteError('invalid_relation_input', 'Canonical delete did not allocate authoritative revisions.');
  }
  const receipt: RelationDeletionReceiptSnapshot = { resourceType: 'relation',
    targetId: validated.relationId, collectionId: validated.collectionId, scope: 'single',
    deletedAt, deleteRevision, operationId, affectedCount: 1, purgeAfter };
  const fence = { contentRevision,
    policyRevision: mutation.allocation.policyRevision ?? collection.policyRevision };
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult(receipt, fence));
  return { kind: 'deleted', receipt, fence, operationId, commitOrdinal: mutation.allocation.commitOrdinal };
}

function validateInput(input: DeleteRelationInput) {
  if (!input || typeof input !== 'object' || !input.actor || !input.command) {
    throw new RelationDeleteError('invalid_relation_input', 'Relation delete input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.collectionId,
    input.relationId, input.command.fingerprint]) if (typeof value !== 'string' || !value.trim()) {
    throw new RelationDeleteError('invalid_relation_input', 'Relation delete identity fields are required.');
  }
  if (input.actor.principalType !== 'account') {
    throw new RelationDeleteError('invalid_relation_input', 'Relation delete requires an account actor.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new RelationDeleteError('invalid_relation_input', 'commandId must be a canonical UUID v4.'); }
  let precondition: { entityTag: string; expectedRevision: string };
  try { precondition = validateRelationPrecondition(input.precondition); }
  catch (error) {
    if (error instanceof RelationUpdateError) throw new RelationDeleteError(error.code as RelationDeleteErrorCode,
      error.message, error.currentEtag);
    throw error;
  }
  return { ...input, command: { commandId, fingerprint: input.command.fingerprint,
    commandScope: input.command.commandScope?.trim()
      || deleteRelationCommandScope(input.collectionId, input.relationId) }, precondition };
}

function conceal(): never { throw new RelationDeleteError('relation_not_found', 'Relation was not found.'); }

function productResult(receipt: RelationDeletionReceiptSnapshot,
  fence: { contentRevision: string; policyRevision: string }): ProductCommandResult {
  return { status: 200, body: Buffer.from(JSON.stringify({ receipt, fence }), 'utf8'), stableHeaders: {
    'cache-control': 'private, no-store', 'content-type': 'application/json',
    location: `/api/v1/collections/${receipt.collectionId}/relations/${receipt.targetId}`,
    etag: `"${receipt.deleteRevision}"` }, mediaType: 'application/json',
  contractVersion: DELETE_RELATION_CONTRACT_VERSION, targetIdentity: receipt.targetId };
}

function mapClaim(claim: Exclude<Awaited<ReturnType<RelationMutationPorts['receipts']['claim']>>,
  { kind: 'claimed' }>): DeleteRelationResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

export interface RelationDeletedPayload extends JsonObject {
  readonly affectedCount: 1; readonly relationId: string; readonly collectionId: string;
  readonly contentRevision: string; readonly deletedAt: string; readonly deleteRevision: string;
  readonly operationId: string; readonly fromNodeId: string; readonly toNodeId: string;
  readonly visibility: Relation['visibility'];
}
