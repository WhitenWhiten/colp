import {
  createHumanAnnotationEditContext,
  prepareAnnotationCreate,
} from '@know-n/colp/server';
import { validateAnnotationProvenance } from '@know-n/colp/semantic';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Actor, Annotation, AnnotationCreate } from '@know-n/colp/types';
import type { AccessPolicyFactsPort, CollectionVisibility, MembershipRole } from '../../access-policy/index.js';
import {
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  assertClosedJsonObject,
  formatUtcDateTime,
  generateOpaqueId,
  type CanonicalMutationInput,
  type CanonicalMutationResult,
  type JsonObject,
} from '../domain/index.js';
import type { LockedCollectionRow } from './ports.js';
import { toProductAnnotationView } from './get-annotation-product.js';

export const ANNOTATION_MAX_VALUE_BYTES = 65_536;
export const ANNOTATION_MAX_JSON_DEPTH = 16;
export const ANNOTATION_MAX_JSON_MEMBERS = 1_024;
export const ANNOTATION_MAX_CANDIDATE_BYTES = 131_072;
export const ANNOTATION_MAX_LIVE_PER_SUBJECT = 256;
export const CREATE_ANNOTATION_CONTRACT_VERSION = '1.0.0';
export const ANNOTATION_CREATED_EVENT_TYPE = 'annotation.created';
export const ANNOTATION_CREATED_EVENT_VERSION = 1;
export const ANNOTATION_CREATED_HANDLER_NAME = 'annotation_created_projection';

type AnnotationType = Annotation['type'];
type AnnotationFormat = NonNullable<Annotation['format']>;
type AnnotationVisibility = Annotation['visibility'];
type AnnotationSubject = Annotation['subject'];

export type AnnotationCreateErrorCode =
  | 'invalid_annotation_input'
  | 'invalid_annotation_document'
  | 'invalid_annotation_subject'
  | 'annotation_not_found'
  | 'insufficient_annotation_permission'
  | 'annotation_visibility_too_broad'
  | 'untrusted_annotation_creator'
  | 'untrusted_ai_provenance'
  | 'reserved_annotation_type'
  | 'annotation_value_too_large'
  | 'annotation_json_too_deep'
  | 'annotation_json_too_many_members'
  | 'annotation_candidate_too_large'
  | 'annotation_subject_limit_reached'
  | 'annotation_note_already_exists';

export class AnnotationCreateError extends Error {
  constructor(readonly code: AnnotationCreateErrorCode, message: string) {
    super(message);
    this.name = 'AnnotationCreateError';
  }
}

export interface CreateAnnotationActor {
  readonly principalId: string;
  readonly subjectId: string;
  readonly principalType: 'account';
  /** Trusted public projection derived from the authenticated Session. */
  readonly creator: Actor;
}

export type ProductAnnotationCreateInput = {
  readonly subject: AnnotationSubject;
  readonly type: AnnotationType;
  readonly format?: AnnotationFormat;
  readonly value: unknown;
  readonly visibility: AnnotationVisibility;
  readonly extensions?: Readonly<Record<string, unknown>>;
  /** Explicitly forbidden at the Product boundary; creator is Session-bound. */
  readonly creator?: never;
  /** Explicitly forbidden for ordinary Product create. */
  readonly provenance?: never;
};

export interface CreateAnnotationInput {
  readonly actor: CreateAnnotationActor;
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly collectionId: string;
  readonly annotation: ProductAnnotationCreateInput;
  readonly annotationId?: string;
  readonly operationId?: string;
  /** Trusted Extension admission only; checked under the existing collection write lock. */
  readonly privateNoteSingleton?: boolean;
}

export interface AnnotationSubjectFacts {
  readonly type: 'collection' | 'node';
  readonly id: string;
  readonly collectionId: string;
  readonly visibility: AnnotationVisibility;
  readonly deletedAt: Date | null;
}

export interface CreateAnnotationPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: { now(): Promise<Date> };
  readonly collections: { lockForUpdate(collectionId: string): Promise<LockedCollectionRow | null> };
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly subjects: {
    resolveLiveSubject(collectionId: string, type: 'collection' | 'node', id: string): Promise<AnnotationSubjectFacts | null>;
  };
  readonly annotations: {
    countLiveForSubject(collectionId: string, type: 'collection' | 'node', id: string): Promise<number>;
    hasOwnPrivateNote?(collectionId: string, subjectId: string, principalId: string): Promise<boolean>;
  };
  readonly canonical: { execute(input: CanonicalMutationInput): Promise<CanonicalMutationResult> };
}

export type CreateAnnotationResult =
  | { readonly kind: 'created'; readonly annotation: Readonly<Annotation>; readonly operationId: string; readonly commitOrdinal: bigint }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array; readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string; readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

const validators = createValidatorRegistry();
const encoder = new TextEncoder();

export function createAnnotationCommandScope(collectionId: string): string {
  return `collection:${collectionId}:annotation:create`;
}

export async function createAnnotation(
  ports: CreateAnnotationPorts,
  input: CreateAnnotationInput,
): Promise<CreateAnnotationResult> {
  const validated = validateInput(input);
  const binding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const collection = await ports.collections.lockForUpdate(validated.collectionId);
  if (!collection || collection.deletedAt !== null) {
    throw new AnnotationCreateError('annotation_not_found', 'Annotation subject was not found.');
  }
  const facts = await ports.accessPolicy.loadCollectionFacts({
    collectionId: validated.collectionId,
    actorSubjectId: validated.actor.subjectId,
  });
  if (!facts || facts.deleted) {
    throw new AnnotationCreateError('annotation_not_found', 'Annotation subject was not found.');
  }

  const subject = await ports.subjects.resolveLiveSubject(
    validated.collectionId,
    validated.annotation.subject.type,
    validated.annotation.subject.id,
  );
  if (!subject || subject.collectionId !== validated.collectionId || subject.deletedAt !== null) {
    throw new AnnotationCreateError('invalid_annotation_subject', 'Subject must be live and belong to the path Collection.');
  }
  authorize(validated.actor.subjectId === facts.ownerSubjectId ? 'owner' : facts.membershipRole,
    validated.annotation.visibility);
  assertVisibilityCeiling(validated.annotation.visibility, facts.visibility, subject.visibility);
  if (input.privateNoteSingleton) {
    if (validated.annotation.type !== 'note' || validated.annotation.visibility !== 'private'
      || subject.type !== 'node' || !ports.annotations.hasOwnPrivateNote) {
      throw new AnnotationCreateError('invalid_annotation_input', 'Private note sync requires its subject guard.');
    }
    if (await ports.annotations.hasOwnPrivateNote(validated.collectionId, subject.id, validated.actor.principalId)) {
      throw new AnnotationCreateError('annotation_note_already_exists', 'A private note was created concurrently.');
    }
  }
  const liveCount = await ports.annotations.countLiveForSubject(
    validated.collectionId, subject.type, subject.id,
  );
  if (liveCount >= ANNOTATION_MAX_LIVE_PER_SUBJECT) {
    throw new AnnotationCreateError('annotation_subject_limit_reached', 'Subject Annotation limit reached.');
  }

  const now = await ports.clock.now();
  const annotationId = validated.annotationId ?? generateOpaqueId();
  const operationId = validated.operationId ?? generateOpaqueId();
  const prepared = prepareAndValidateCreate(validated.annotation, validated.collectionId);
  const resourceRevisionPlaceholder = 'pending-revision';
  const dateTime = formatUtcDateTime(now);
  const candidate = buildCandidate({
    prepared, id: annotationId, collectionId: validated.collectionId,
    creator: validated.actor.creator, createdAt: dateTime, updatedAt: dateTime,
    revision: resourceRevisionPlaceholder,
  });
  assertCandidate(candidate);
  try {
    assertClosedJsonObject(candidate, 'Canonical Annotation');
  } catch {
    throw new AnnotationCreateError('invalid_annotation_document', 'Canonical Annotation must be a closed JSON object.');
  }
  const closed: JsonObject = candidate;
  const extensions = closed.extensions ?? {};
  try {
    assertClosedJsonObject(extensions, 'Canonical Annotation extensions');
  } catch {
    throw new AnnotationCreateError('invalid_annotation_document', 'Canonical Annotation must be a closed JSON object.');
  }

  const mutation = await ports.canonical.execute({
    operationId,
    collectionId: validated.collectionId,
    actor: { principalId: validated.actor.principalId, principalType: validated.actor.principalType },
    mutation: {
      action: 'create',
      target: { collectionId: validated.collectionId, resourceId: annotationId, resourceKind: 'annotation' },
      parentId: null,
      fields: {
        kindFields: {
          subject: closed.subject!,
          type: closed.type!,
          ...(closed.format ? { format: closed.format } : {}),
          value: closed.value!,
          visibility: closed.visibility!,
          creator: closed.creator!,
          ...(closed.provenance ? { provenance: closed.provenance } : {}),
        },
        extensions,
      },
      trustedFacts: {
        creatorPrincipalId: validated.actor.principalId,
        createdAt: dateTime,
        updatedAt: dateTime,
      },
    },
  });
  const annotation = buildCandidate({
    prepared, id: annotationId, collectionId: validated.collectionId,
    creator: validated.actor.creator, createdAt: dateTime, updatedAt: dateTime,
    revision: mutation.allocation.resourceRevision!,
  });
  assertCandidate(annotation);

  const result = productResult(annotation);
  await ports.receipts.complete(binding, validated.command.fingerprint, result);
  return { kind: 'created', annotation, operationId, commitOrdinal: mutation.allocation.commitOrdinal };
}

interface ValidatedInput extends CreateAnnotationInput {
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string };
}

function validateInput(input: CreateAnnotationInput): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command || !input.annotation) {
    throw new AnnotationCreateError('invalid_annotation_input', 'Annotation create input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.collectionId, input.command.fingerprint]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AnnotationCreateError('invalid_annotation_input', 'Annotation create identity fields are required.');
    }
  }
  if (input.actor.principalType !== 'account' || !input.actor.creator
    || typeof input.actor.creator.id !== 'string' || typeof input.actor.creator.name !== 'string') {
    throw new AnnotationCreateError('invalid_annotation_input', 'A trusted account creator projection is required.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new AnnotationCreateError('invalid_annotation_input', 'commandId must be a canonical UUID v4.'); }
  const record = input.annotation;
  if (Object.hasOwn(record, 'creator')) {
    throw new AnnotationCreateError('untrusted_annotation_creator', 'Product input cannot choose Annotation creator.');
  }
  if (Object.hasOwn(record, 'provenance')) {
    throw new AnnotationCreateError('untrusted_ai_provenance', 'Ordinary Product create cannot provide provenance.');
  }
  if (input.annotation.type === 'reading_state') {
    throw new AnnotationCreateError('reserved_annotation_type', 'reading_state is owned by Reading Progress.');
  }
  assertBudgets(input.annotation);
  return {
    ...input,
    command: { commandId, fingerprint: input.command.fingerprint,
      commandScope: input.command.commandScope?.trim() || createAnnotationCommandScope(input.collectionId) },
  };
}

function prepareAndValidateCreate(input: ProductAnnotationCreateInput, collectionId: string): Readonly<AnnotationCreate> {
  const wire: AnnotationCreate = {
    subject: input.subject, type: input.type, ...(input.format ? { format: input.format } : {}),
    value: input.value, visibility: input.visibility,
    ...(input.extensions ? { extensions: { ...input.extensions } } : {}),
  };
  const structural = validators.validate('annotationCreate', wire);
  if (!structural.valid) throw new AnnotationCreateError('invalid_annotation_document', 'Annotation create failed COLP schema validation.');
  const semantic = validateAnnotationProvenance(wire, { operation: 'create', contentOrigin: 'human', collectionId });
  if (!semantic.valid) throw new AnnotationCreateError('invalid_annotation_document', 'Annotation create failed COLP semantic validation.');
  try {
    return prepareAnnotationCreate(wire, createHumanAnnotationEditContext(), { collectionId });
  } catch {
    throw new AnnotationCreateError('invalid_annotation_document', 'Annotation create failed COLP provenance preparation.');
  }
}

function buildCandidate(input: {
  readonly prepared: Readonly<AnnotationCreate>; readonly id: string; readonly collectionId: string;
  readonly creator: Actor; readonly createdAt: string; readonly updatedAt: string; readonly revision: string;
}): Readonly<Annotation> {
  return Object.freeze({ ...input.prepared, id: input.id, collectionId: input.collectionId,
    creator: Object.freeze({ ...input.creator }), createdAt: input.createdAt,
    updatedAt: input.updatedAt, revision: input.revision }) as Readonly<Annotation>;
}

function assertCandidate(candidate: Readonly<Annotation>): void {
  const structural = validators.validate('annotation', candidate);
  if (!structural.valid) throw new AnnotationCreateError('invalid_annotation_document', 'Canonical Annotation failed COLP schema validation.');
  const semantic = validateAnnotationProvenance(candidate, {
    operation: 'create', contentOrigin: 'human', collectionId: candidate.collectionId,
  });
  if (!semantic.valid) throw new AnnotationCreateError('invalid_annotation_document', 'Canonical Annotation failed COLP semantic validation.');
  const bytes = encoder.encode(canonicalJson(candidate)).byteLength;
  if (bytes > ANNOTATION_MAX_CANDIDATE_BYTES) {
    throw new AnnotationCreateError('annotation_candidate_too_large', 'Canonical Annotation exceeds byte budget.');
  }
}

function assertBudgets(input: ProductAnnotationCreateInput): void {
  let valueJson: string;
  try { valueJson = canonicalJson(input.value); }
  catch { throw new AnnotationCreateError('invalid_annotation_document', 'Annotation value must be I-JSON.'); }
  if (encoder.encode(valueJson).byteLength > ANNOTATION_MAX_VALUE_BYTES) {
    throw new AnnotationCreateError('annotation_value_too_large', 'Annotation value exceeds byte budget.');
  }
  const budget = jsonShape(input.value);
  if (budget.depth > ANNOTATION_MAX_JSON_DEPTH) {
    throw new AnnotationCreateError('annotation_json_too_deep', 'Annotation value exceeds JSON depth budget.');
  }
  if (budget.members > ANNOTATION_MAX_JSON_MEMBERS) {
    throw new AnnotationCreateError('annotation_json_too_many_members', 'Annotation value exceeds JSON member budget.');
  }
  const documentBudget = jsonShape(input);
  if (documentBudget.depth > ANNOTATION_MAX_JSON_DEPTH) {
    throw new AnnotationCreateError('annotation_json_too_deep', 'Annotation body exceeds JSON depth budget.');
  }
  if (documentBudget.members > ANNOTATION_MAX_JSON_MEMBERS) {
    throw new AnnotationCreateError('annotation_json_too_many_members', 'Annotation body exceeds JSON member budget.');
  }
  let candidateBytes: number;
  try { candidateBytes = encoder.encode(canonicalJson(input)).byteLength; }
  catch { throw new AnnotationCreateError('invalid_annotation_document', 'Annotation create must be I-JSON.'); }
  if (candidateBytes > ANNOTATION_MAX_CANDIDATE_BYTES) {
    throw new AnnotationCreateError('annotation_candidate_too_large', 'Annotation candidate exceeds byte budget.');
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

function authorize(role: MembershipRole | null, visibility: AnnotationVisibility): void {
  if (role === null) throw new AnnotationCreateError('annotation_not_found', 'Annotation subject was not found.');
  if ((role === 'viewer' && visibility !== 'private')) {
    throw new AnnotationCreateError('insufficient_annotation_permission', 'Member may create only private Annotations.');
  }
}

function assertVisibilityCeiling(
  requested: AnnotationVisibility,
  collection: CollectionVisibility,
  subject: AnnotationVisibility,
): void {
  const rank: Record<AnnotationVisibility, number> = { private: 0, protected: 1, unlisted: 2, public: 3 };
  if (rank[requested] > rank[collection] || rank[requested] > rank[subject]) {
    throw new AnnotationCreateError('annotation_visibility_too_broad', 'Annotation visibility exceeds its subject policy.');
  }
}

function productResult(annotation: Readonly<Annotation>): ProductCommandResult {
  const body = Buffer.from(canonicalJson(toProductAnnotationView(annotation)), 'utf8');
  return { status: 201, body, stableHeaders: {
    'cache-control': 'private, no-store', 'content-type': 'application/json',
    location: `/api/v1/collections/${annotation.collectionId}/annotations/${annotation.id}`,
    etag: `"${annotation.revision}"`,
  }, mediaType: 'application/json', contractVersion: CREATE_ANNOTATION_CONTRACT_VERSION,
  targetIdentity: annotation.id };
}

function mapClaim(claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>): CreateAnnotationResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
