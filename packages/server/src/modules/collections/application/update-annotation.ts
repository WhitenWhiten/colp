import {
  createHumanAnnotationEditContext,
  prepareAnnotationMergePatch,
} from '@know-n/colp/server';
import { validateAnnotationProvenance } from '@know-n/colp/semantic';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Annotation, AnnotationMergePatch } from '@know-n/colp/types';
import type { CollectionVisibility, MembershipRole } from '../../access-policy/index.js';
import {
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  assertClosedJsonObject,
  formatUtcDateTime,
  generateOpaqueId,
  type CanonicalMutationInput,
  type JsonObject,
} from '../domain/index.js';
import {
  ANNOTATION_MAX_CANDIDATE_BYTES,
  ANNOTATION_MAX_JSON_DEPTH,
  ANNOTATION_MAX_JSON_MEMBERS,
  ANNOTATION_MAX_VALUE_BYTES,
  type AnnotationSubjectFacts,
  type CreateAnnotationPorts,
} from './create-annotation.js';
import { toProductAnnotationView } from './get-annotation-product.js';

export const UPDATE_ANNOTATION_CONTRACT_VERSION = '1.0.0';
export const ANNOTATION_UPDATED_EVENT_TYPE = 'annotation.updated';
export const ANNOTATION_UPDATED_EVENT_VERSION = 1;
export const ANNOTATION_UPDATED_HANDLER_NAME = 'annotation_updated_projection';

type AnnotationFormat = NonNullable<Annotation['format']>;
type AnnotationVisibility = Annotation['visibility'];

export type AnnotationUpdateErrorCode =
  | 'invalid_annotation_input'
  | 'invalid_annotation_patch'
  | 'invalid_annotation_document'
  | 'annotation_not_found'
  | 'annotation_precondition_required'
  | 'invalid_annotation_precondition'
  | 'annotation_precondition_failed'
  | 'insufficient_annotation_permission'
  | 'annotation_visibility_too_broad'
  | 'untrusted_ai_provenance'
  | 'untrusted_annotation_context'
  | 'annotation_value_too_large'
  | 'annotation_json_too_deep'
  | 'annotation_json_too_many_members'
  | 'annotation_candidate_too_large';

export class AnnotationUpdateError extends Error {
  constructor(
    readonly code: AnnotationUpdateErrorCode,
    message: string,
    readonly currentEtag?: string,
  ) {
    super(message);
    this.name = 'AnnotationUpdateError';
  }
}

export interface AnnotationUpdateActor {
  readonly principalId: string;
  readonly subjectId: string;
  readonly principalType: 'account';
}

/** Raw-header cardinality is classified upstream and preserved as explicit evidence. */
export type AnnotationIfMatchEvidence =
  | {
      readonly kind: 'single-strong-if-match';
      readonly entityTag: string;
      readonly expectedRevision: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'duplicate'; readonly values: readonly string[] };

/** RFC 7396 fields exposed by P2B-05. All identity and trusted provenance fields are absent. */
export interface ProductAnnotationMergePatch {
  readonly format?: AnnotationFormat | null;
  readonly value?: unknown;
  readonly visibility?: AnnotationVisibility;
  readonly extensions?: Readonly<Record<string, unknown>> | null;
  readonly provenance?: never;
}

export interface UpdateAnnotationInput {
  readonly actor: AnnotationUpdateActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope?: string;
  };
  readonly collectionId: string;
  readonly annotationId: string;
  readonly precondition: AnnotationIfMatchEvidence;
  readonly patch: ProductAnnotationMergePatch;
  /** Caller-created mutation contexts are forbidden; the application creates its own trusted context. */
  readonly context?: never;
  readonly operationId?: string;
}

export interface AnnotationAuthorityRecord {
  readonly annotation: Readonly<Annotation>;
  readonly creatorPrincipalId: string;
  readonly deletedAt: Date | null;
  /** Authoritative live same-Collection sources resolved by the PostgreSQL adapter. */
  readonly provenanceSourceNodeIds: readonly string[];
}

export interface AnnotationMutationPorts extends CreateAnnotationPorts {
  readonly annotations: CreateAnnotationPorts['annotations'] & {
    loadAuthoritativeForUpdate(
      collectionId: string,
      annotationId: string,
      requestingPrincipalId: string,
    ): Promise<AnnotationAuthorityRecord | null>;
  };
}

export type UpdateAnnotationResult =
  | {
      readonly kind: 'updated';
      readonly annotation: Readonly<Annotation>;
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

interface ValidatedUpdateAnnotationInput extends Omit<
  UpdateAnnotationInput,
  'precondition' | 'command' | 'patch'
> {
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly precondition: {
    readonly entityTag: string;
    readonly expectedRevision: string;
  };
  readonly patch: AnnotationMergePatch;
}

const validators = createValidatorRegistry();
const encoder = new TextEncoder();
const revisionPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const patchKeys = new Set(['format', 'value', 'visibility', 'provenance', 'extensions']);
const immutableKeys = new Set([
  'id', 'collectionId', 'subject', 'type', 'creator', 'createdAt', 'updatedAt', 'revision',
]);

export function updateAnnotationCommandScope(collectionId: string, annotationId: string): string {
  return `collection:${collectionId}:annotation:${annotationId}:update`;
}

export async function updateAnnotation(
  ports: AnnotationMutationPorts,
  input: UpdateAnnotationInput,
): Promise<UpdateAnnotationResult> {
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
  const isCreator = authority.creatorPrincipalId === validated.actor.principalId;
  authorizeCurrent(current.visibility, role, isCreator);

  const subject = await ports.subjects.resolveLiveSubject(
    validated.collectionId,
    current.subject.type,
    current.subject.id,
  );
  if (!subject || subject.collectionId !== validated.collectionId || subject.deletedAt !== null) conceal();

  if (current.revision !== validated.precondition.expectedRevision) {
    throw new AnnotationUpdateError(
      'annotation_precondition_failed',
      'Annotation changed before this patch was applied.',
      `"${current.revision}"`,
    );
  }

  const candidate = prepareCandidate(current, validated.patch, authority);
  authorizeTransition(current.visibility, candidate.visibility, role, isCreator);
  assertVisibilityCeiling(candidate.visibility, facts.visibility, subject);
  assertBudgets(validated.patch, candidate);
  try {
    assertClosedJsonObject(candidate, 'Canonical Annotation');
  } catch {
    throw new AnnotationUpdateError('invalid_annotation_document', 'Canonical Annotation must be a closed JSON object.');
  }
  const closed: JsonObject = candidate;
  const extensions = closed.extensions ?? {};
  try {
    assertClosedJsonObject(extensions, 'Canonical Annotation extensions');
  } catch {
    throw new AnnotationUpdateError('invalid_annotation_document', 'Canonical Annotation must be a closed JSON object.');
  }

  const now = await ports.clock.now();
  const updatedAt = formatUtcDateTime(now);
  const operationId = validated.operationId ?? generateOpaqueId();
  const canonicalInput: CanonicalMutationInput = {
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'update',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.annotationId,
        resourceKind: 'annotation',
      },
      parentId: null,
      expectedResourceRevision: current.revision,
      fields: {
        kindFields: {
          subject: closed.subject!,
          type: closed.type!,
          ...(closed.format ? { format: closed.format } : {}),
          value: closed.value!,
          visibility: closed.visibility!,
          ...(closed.creator ? { creator: closed.creator } : {}),
          ...(closed.provenance ? { provenance: closed.provenance } : {}),
        },
        extensions,
      },
      trustedFacts: {
        creatorPrincipalId: authority.creatorPrincipalId,
        createdAt: current.createdAt,
        updatedAt,
        previousVisibility: current.visibility,
        publicRepresentationChanged:
          current.visibility !== 'private' || candidate.visibility !== 'private',
      },
    },
  };
  const mutation = await ports.canonical.execute(canonicalInput);
  const annotation = Object.freeze({
    ...candidate,
    revision: mutation.allocation.resourceRevision!,
    updatedAt,
  }) as Readonly<Annotation>;
  assertCompleteCandidate(annotation, authority.provenanceSourceNodeIds);

  await ports.receipts.complete(
    binding,
    validated.command.fingerprint,
    productResult(annotation),
  );
  return {
    kind: 'updated',
    annotation,
    operationId,
    commitOrdinal: mutation.allocation.commitOrdinal,
  };
}

function validateInput(input: UpdateAnnotationInput): ValidatedUpdateAnnotationInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command) {
    throw new AnnotationUpdateError('invalid_annotation_input', 'Annotation update input is required.');
  }
  if (Object.hasOwn(input as object, 'context')) {
    throw new AnnotationUpdateError(
      'untrusted_annotation_context',
      'Caller-supplied Annotation mutation context is forbidden.',
    );
  }
  for (const value of [
    input.actor.principalId,
    input.actor.subjectId,
    input.collectionId,
    input.annotationId,
    input.command.fingerprint,
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AnnotationUpdateError('invalid_annotation_input', 'Annotation update identity fields are required.');
    }
  }
  if (input.actor.principalType !== 'account') {
    throw new AnnotationUpdateError('invalid_annotation_input', 'Annotation update requires an account actor.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch {
    throw new AnnotationUpdateError('invalid_annotation_input', 'commandId must be a canonical UUID v4.');
  }
  const precondition = validatePrecondition(input.precondition);
  const patch = validatePatch(input.patch);
  return {
    ...input,
    command: {
      commandId,
      fingerprint: input.command.fingerprint,
      commandScope: input.command.commandScope?.trim()
        || updateAnnotationCommandScope(input.collectionId, input.annotationId),
    },
    precondition,
    patch,
  };
}

function validatePrecondition(value: AnnotationIfMatchEvidence | undefined): {
  readonly entityTag: string;
  readonly expectedRevision: string;
} {
  if (!value || value.kind === 'missing') {
    throw new AnnotationUpdateError(
      'annotation_precondition_required',
      'A single strong If-Match precondition is required.',
    );
  }
  if (value.kind !== 'single-strong-if-match') {
    throw new AnnotationUpdateError(
      'invalid_annotation_precondition',
      'Duplicate If-Match fields are forbidden.',
    );
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3
    || keys[0] !== 'entityTag' || keys[1] !== 'expectedRevision' || keys[2] !== 'kind'
    || !revisionPattern.test(value.expectedRevision)
    || value.entityTag !== `"${value.expectedRevision}"`) {
    throw new AnnotationUpdateError(
      'invalid_annotation_precondition',
      'If-Match must contain exactly one well-formed strong entity-tag.',
    );
  }
  return { entityTag: value.entityTag, expectedRevision: value.expectedRevision };
}

function validatePatch(value: ProductAnnotationMergePatch): AnnotationMergePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnnotationUpdateError('invalid_annotation_patch', 'Annotation merge patch must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new AnnotationUpdateError('invalid_annotation_patch', 'Annotation merge patch cannot be empty.');
  }
  for (const key of keys) {
    if (immutableKeys.has(key) || !patchKeys.has(key)) {
      throw new AnnotationUpdateError(
        'invalid_annotation_patch',
        `Annotation merge patch property "${key}" is not mutable.`,
      );
    }
  }
  if (Object.hasOwn(record, 'provenance')) {
    throw new AnnotationUpdateError(
      'untrusted_ai_provenance',
      'Ordinary Product updates cannot provide Annotation provenance.',
    );
  }
  const structural = validators.validate('annotationMergePatch', value);
  if (!structural.valid) {
    throw new AnnotationUpdateError(
      'invalid_annotation_document',
      'Annotation merge patch failed COLP schema validation.',
    );
  }
  return structuredClone(value) as AnnotationMergePatch;
}

function prepareCandidate(
  current: Readonly<Annotation>,
  patch: AnnotationMergePatch,
  authority: AnnotationAuthorityRecord,
): Readonly<Annotation> {
  try {
    const sourceIds = new Set(authority.provenanceSourceNodeIds);
    const candidate = prepareAnnotationMergePatch(
      current as Annotation,
      patch,
      createHumanAnnotationEditContext(),
      {
        hasNode(collectionId, nodeId) {
          return collectionId === current.collectionId && sourceIds.has(nodeId);
        },
      },
    );
    assertCompleteCandidate(candidate, authority.provenanceSourceNodeIds);
    return candidate;
  } catch (error) {
    if (error instanceof AnnotationUpdateError) throw error;
    throw new AnnotationUpdateError(
      'invalid_annotation_document',
      'Annotation merge patch did not produce a valid complete resource.',
    );
  }
}

function assertCompleteCandidate(
  candidate: Readonly<Annotation>,
  provenanceSourceNodeIds: readonly string[],
): void {
  const structural = validators.validate('annotation', candidate);
  if (!structural.valid) {
    throw new AnnotationUpdateError('invalid_annotation_document', 'Canonical Annotation failed schema validation.');
  }
  const sourceIds = new Set(provenanceSourceNodeIds);
  const contentOrigin = candidate.provenance?.kind ?? 'human';
  const semantic = validateAnnotationProvenance(candidate, {
    operation: 'complete',
    contentOrigin,
    collectionId: candidate.collectionId,
    resolveNode: (nodeId) => sourceIds.has(nodeId)
      ? { collectionId: candidate.collectionId }
      : undefined,
  });
  if (!semantic.valid) {
    throw new AnnotationUpdateError('invalid_annotation_document', 'Canonical Annotation failed semantic validation.');
  }
}

function authorizeCurrent(
  visibility: AnnotationVisibility,
  role: MembershipRole | null,
  isCreator: boolean,
): void {
  if (role === null) conceal();
  if (visibility === 'private' && !isCreator) conceal();
  if (visibility !== 'private' && !isCreator && role !== 'owner' && role !== 'editor') conceal();
}

function authorizeTransition(
  previous: AnnotationVisibility,
  next: AnnotationVisibility,
  role: MembershipRole | null,
  isCreator: boolean,
): void {
  const rank: Record<AnnotationVisibility, number> = {
    private: 0, protected: 1, unlisted: 2, public: 3,
  };
  if (rank[next] > rank[previous] && role !== 'owner' && role !== 'editor') {
    throw new AnnotationUpdateError(
      'insufficient_annotation_permission',
      'Visibility widening requires Collection editor permission.',
    );
  }
  if (next === 'private' && !isCreator) {
    throw new AnnotationUpdateError(
      'insufficient_annotation_permission',
      'Only the Annotation creator may make it private.',
    );
  }
}

function assertVisibilityCeiling(
  requested: AnnotationVisibility,
  collection: CollectionVisibility,
  subject: AnnotationSubjectFacts,
): void {
  const rank: Record<AnnotationVisibility, number> = {
    private: 0, protected: 1, unlisted: 2, public: 3,
  };
  if (rank[requested] > rank[collection] || rank[requested] > rank[subject.visibility]) {
    throw new AnnotationUpdateError(
      'annotation_visibility_too_broad',
      'Annotation visibility exceeds its subject or Collection visibility.',
    );
  }
}

function assertBudgets(patch: AnnotationMergePatch, candidate: Readonly<Annotation>): void {
  if (Object.hasOwn(patch, 'value')) {
    let valueJson: string;
    try { valueJson = canonicalJson(candidate.value); }
    catch {
      throw new AnnotationUpdateError('invalid_annotation_document', 'Annotation value must be I-JSON.');
    }
    if (encoder.encode(valueJson).byteLength > ANNOTATION_MAX_VALUE_BYTES) {
      throw new AnnotationUpdateError('annotation_value_too_large', 'Annotation value exceeds byte budget.');
    }
  }
  const patchShape = jsonShape(patch);
  const candidateShape = jsonShape(candidate);
  if (patchShape.depth > ANNOTATION_MAX_JSON_DEPTH || candidateShape.depth > ANNOTATION_MAX_JSON_DEPTH) {
    throw new AnnotationUpdateError('annotation_json_too_deep', 'Annotation update exceeds JSON depth budget.');
  }
  if (patchShape.members > ANNOTATION_MAX_JSON_MEMBERS
    || candidateShape.members > ANNOTATION_MAX_JSON_MEMBERS) {
    throw new AnnotationUpdateError(
      'annotation_json_too_many_members',
      'Annotation update exceeds JSON member budget.',
    );
  }
  let bytes: number;
  try { bytes = encoder.encode(canonicalJson(candidate)).byteLength; }
  catch {
    throw new AnnotationUpdateError('invalid_annotation_document', 'Annotation update must be I-JSON.');
  }
  if (bytes > ANNOTATION_MAX_CANDIDATE_BYTES) {
    throw new AnnotationUpdateError('annotation_candidate_too_large', 'Canonical Annotation exceeds byte budget.');
  }
}

function jsonShape(value: unknown, depth = 0): { depth: number; members: number } {
  if (value === null || typeof value !== 'object') return { depth, members: 0 };
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  let maxDepth = depth + 1;
  let members = children.length;
  for (const child of children) {
    const nested = jsonShape(child, depth + 1);
    maxDepth = Math.max(maxDepth, nested.depth);
    members += nested.members;
  }
  return { depth: maxDepth, members };
}

function productResult(annotation: Readonly<Annotation>): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(canonicalJson(toProductAnnotationView(annotation)), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      etag: `"${annotation.revision}"`,
      location: `/api/v1/collections/${annotation.collectionId}/annotations/${annotation.id}`,
    },
    mediaType: 'application/json',
    contractVersion: UPDATE_ANNOTATION_CONTRACT_VERSION,
    targetIdentity: annotation.id,
  };
}

export interface AnnotationUpdatedPayload extends JsonObject {
  readonly annotationId: string;
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly previousVisibility: AnnotationVisibility;
  readonly publicRepresentationChanged: boolean;
  readonly resourceRevision: string;
  readonly subjectId: string;
  readonly subjectType: 'collection' | 'node';
  readonly visibility: AnnotationVisibility;
}

/** Producer-side closed annotation.updated@1 payload validation. */
export function assertAnnotationUpdatedPayload(value: unknown): asserts value is AnnotationUpdatedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnnotationUpdateError('invalid_annotation_document', 'annotation.updated payload must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'annotationId', 'collectionId', 'contentRevision', 'previousVisibility',
    'publicRepresentationChanged', 'resourceRevision', 'subjectId', 'subjectType', 'visibility',
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new AnnotationUpdateError('invalid_annotation_document', 'annotation.updated payload must be closed.');
  }
  for (const key of [
    'annotationId', 'collectionId', 'contentRevision', 'resourceRevision', 'subjectId',
  ]) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      throw new AnnotationUpdateError(
        'invalid_annotation_document',
        `annotation.updated payload.${key} must be a non-empty string.`,
      );
    }
  }
  const visibility = record.visibility;
  const previousVisibility = record.previousVisibility;
  const visibilities = new Set(['public', 'unlisted', 'protected', 'private']);
  if (!visibilities.has(String(visibility)) || !visibilities.has(String(previousVisibility))
    || (record.subjectType !== 'collection' && record.subjectType !== 'node')
    || typeof record.publicRepresentationChanged !== 'boolean'
    || record.publicRepresentationChanged
      !== (previousVisibility !== 'private' || visibility !== 'private')) {
    throw new AnnotationUpdateError('invalid_annotation_document', 'annotation.updated payload facts are invalid.');
  }
}

function mapClaim(
  claim: Exclude<
    Awaited<ReturnType<AnnotationMutationPorts['receipts']['claim']>>,
    { kind: 'claimed' }
  >,
): UpdateAnnotationResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

function conceal(): never {
  throw new AnnotationUpdateError('annotation_not_found', 'Annotation was not found.');
}
