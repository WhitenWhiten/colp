import { isOpaqueId } from '@know-n/colp/semantic';
import { createValidatorRegistry, validateWireDocument } from '@know-n/colp/schema';
import type { Relation, RelationCreate } from '@know-n/colp/types';
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
import { toProductRelationView } from './get-relation-product.js';

export const CREATE_RELATION_CONTRACT_VERSION = '1.0.0';
export const RELATION_CREATED_EVENT_TYPE = 'relation.created';
export const RELATION_CREATED_EVENT_VERSION = 1;
export const RELATION_CREATED_HANDLER_NAME = 'relation_created_projection';
export const RELATION_MAX_CANDIDATE_BYTES = 131_072;
export const RELATION_MAX_LABEL_BYTES = 4_096;

type RelationVisibility = Relation['visibility'];

export type RelationCreateErrorCode =
  | 'invalid_relation_input'
  | 'invalid_relation_document'
  | 'untrusted_relation_identity'
  | 'relation_not_found'
  | 'invalid_relation_endpoint'
  | 'relation_self_forbidden'
  | 'relation_already_exists'
  | 'insufficient_relation_permission'
  | 'relation_visibility_too_broad'
  | 'relation_candidate_too_large';

export class RelationCreateError extends Error {
  constructor(readonly code: RelationCreateErrorCode, message: string) {
    super(message);
    this.name = 'RelationCreateError';
  }
}

export interface CreateRelationActor {
  readonly principalId: string;
  readonly subjectId: string;
  readonly principalType: 'account';
}

export interface ProductRelationCreateInput extends RelationCreate {
  /** Path identity is authoritative and must never be duplicated in the body. */
  readonly collectionId?: never;
}

export interface CreateRelationInput {
  readonly actor: CreateRelationActor;
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly collectionId: string;
  readonly relation: ProductRelationCreateInput;
  readonly relationId?: string;
  readonly operationId?: string;
}

export interface RelationEndpointFacts {
  readonly id: string;
  readonly collectionId: string;
  readonly visibility: RelationVisibility;
  readonly deletedAt: Date | null;
}

export interface CreateRelationPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: { now(): Promise<Date> };
  readonly collections: { lockForUpdate(collectionId: string): Promise<LockedCollectionRow | null> };
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly endpoints: {
    resolveLiveEndpoint(collectionId: string, nodeId: string): Promise<RelationEndpointFacts | null>;
  };
  readonly relations: {
    hasLiveSemanticEdge(collectionId: string, fromNodeId: string, toNodeId: string,
      type: RelationCreate['type']): Promise<boolean>;
  };
  readonly canonical: { execute(input: CanonicalMutationInput): Promise<CanonicalMutationResult> };
}

export type CreateRelationResult =
  | { readonly kind: 'created'; readonly relation: Readonly<Relation>; readonly operationId: string;
      readonly commitOrdinal: bigint; readonly fence: { readonly contentRevision: string } }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

const validators = createValidatorRegistry();
const encoder = new TextEncoder();

export function createRelationCommandScope(collectionId: string): string {
  return `collection:${collectionId}:relation:create`;
}

export async function createRelation(
  ports: CreateRelationPorts,
  input: CreateRelationInput,
): Promise<CreateRelationResult> {
  const validated = validateInput(input);
  const binding = { principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope, commandId: validated.command.commandId };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const collection = await ports.collections.lockForUpdate(validated.collectionId);
  if (!collection || collection.deletedAt !== null) {
    throw new RelationCreateError('relation_not_found', 'Relation Collection was not found.');
  }
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId: validated.collectionId,
    actorSubjectId: validated.actor.subjectId });
  if (!facts || facts.deleted) throw new RelationCreateError('relation_not_found', 'Relation Collection was not found.');
  authorize(validated.actor.subjectId === facts.ownerSubjectId ? 'owner' : facts.membershipRole);

  const [from, to] = await Promise.all([
    ports.endpoints.resolveLiveEndpoint(validated.collectionId, validated.relation.fromNodeId),
    ports.endpoints.resolveLiveEndpoint(validated.collectionId, validated.relation.toNodeId),
  ]);
  if (!validEndpoint(from, validated.collectionId) || !validEndpoint(to, validated.collectionId)) {
    throw new RelationCreateError('invalid_relation_endpoint',
      'Both Relation endpoints must be live Nodes in the path Collection.');
  }
  assertVisibilityCeiling(validated.relation.visibility, facts.visibility, from.visibility, to.visibility);
  if (await ports.relations.hasLiveSemanticEdge(validated.collectionId, from.id, to.id, validated.relation.type)) {
    throw new RelationCreateError('relation_already_exists', 'The directed semantic Relation already exists.');
  }

  const now = await ports.clock.now();
  const relationId = validated.relationId ?? generateOpaqueId();
  const operationId = validated.operationId ?? generateOpaqueId();
  const dateTime = formatUtcDateTime(now);
  const candidate = buildCandidate(validated.relation, relationId, validated.collectionId,
    dateTime, 'pending-revision');
  assertCandidate(candidate);
  try {
    assertClosedJsonObject(candidate, 'Canonical Relation');
  } catch {
    throw new RelationCreateError('invalid_relation_document', 'Canonical Relation must be a closed JSON object.');
  }
  const closed: JsonObject = candidate;
  const extensions = closed.extensions ?? {};
  try {
    assertClosedJsonObject(extensions, 'Canonical Relation extensions');
  } catch {
    throw new RelationCreateError('invalid_relation_document', 'Canonical Relation must be a closed JSON object.');
  }
  const kindFields = {
    type: closed.type!, fromNodeId: closed.fromNodeId!, toNodeId: closed.toNodeId!,
    ...(closed.label === undefined ? {} : { label: closed.label }),
    visibility: closed.visibility!,
  };
  const mutation = await ports.canonical.execute({
    operationId, collectionId: validated.collectionId,
    actor: { principalId: validated.actor.principalId, principalType: validated.actor.principalType },
    mutation: { action: 'create', target: { collectionId: validated.collectionId,
      resourceId: relationId, resourceKind: 'relation' }, parentId: null,
      fields: { kindFields, extensions },
      trustedFacts: { createdAt: dateTime, updatedAt: dateTime } },
  });
  const relation = buildCandidate(validated.relation, relationId, validated.collectionId,
    dateTime, mutation.allocation.resourceRevision!);
  assertCandidate(relation);
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult(relation));
  return { kind: 'created', relation, operationId, commitOrdinal: mutation.allocation.commitOrdinal,
    fence: { contentRevision: mutation.allocation.contentRevision! } };
}

interface ValidatedInput extends CreateRelationInput {
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string };
}

function validateInput(input: CreateRelationInput): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command || !input.relation) {
    throw new RelationCreateError('invalid_relation_input', 'Relation create input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.collectionId, input.command.fingerprint]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RelationCreateError('invalid_relation_input', 'Relation identity fields are required.');
    }
  }
  if (input.actor.principalType !== 'account') {
    throw new RelationCreateError('invalid_relation_input', 'Relation actor must be an account.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new RelationCreateError('invalid_relation_input', 'commandId must be a canonical UUID v4.'); }
  if (Object.hasOwn(input.relation as object, 'collectionId')) {
    throw new RelationCreateError('untrusted_relation_identity', 'Product input cannot choose Relation Collection identity.');
  }
  if (!isOpaqueId(input.relation.fromNodeId) || !isOpaqueId(input.relation.toNodeId)) {
    throw new RelationCreateError('invalid_relation_document', 'Relation endpoints must be local opaque Node IDs.');
  }
  if (input.relation.fromNodeId === input.relation.toNodeId) {
    throw new RelationCreateError('relation_self_forbidden', 'Self Relations are not supported.');
  }
  assertRelationCreateSemantics(input.relation);
  return { ...input, command: { commandId, fingerprint: input.command.fingerprint,
    commandScope: input.command.commandScope?.trim() || createRelationCommandScope(input.collectionId) } };
}

/** Public COLP schema plus the create semantic rule not expressible in its JSON Schema. */
function assertRelationCreateSemantics(value: ProductRelationCreateInput): void {
  const validation = validateWireDocument<RelationCreate, RelationSemanticIssue>(
    validators,
    'relationCreate',
    value,
    validateRelationSemantics,
  );
  if (!validation.valid) {
    throw new RelationCreateError('invalid_relation_document', 'Relation create failed COLP validation.');
  }
  if (value.label !== undefined && encoder.encode(value.label).byteLength > RELATION_MAX_LABEL_BYTES) {
    throw new RelationCreateError('relation_candidate_too_large', 'Relation label exceeds its byte budget.');
  }
  let bytes: number;
  try { bytes = encoder.encode(canonicalJson(value)).byteLength; }
  catch { throw new RelationCreateError('invalid_relation_document', 'Relation create must be I-JSON.'); }
  if (bytes > RELATION_MAX_CANDIDATE_BYTES) {
    throw new RelationCreateError('relation_candidate_too_large', 'Relation exceeds its byte budget.');
  }
}

function buildCandidate(input: ProductRelationCreateInput, id: string, collectionId: string,
  dateTime: string, revision: string): Readonly<Relation> {
  const { extensions, ...fields } = input;
  return Object.freeze({ ...fields,
    ...(extensions && Object.keys(extensions).length > 0 ? { extensions: { ...extensions } } : {}),
    id, collectionId, createdAt: dateTime, updatedAt: dateTime, revision }) as Readonly<Relation>;
}

function assertCandidate(candidate: Readonly<Relation>): void {
  const validation = validateWireDocument<Relation, RelationSemanticIssue>(
    validators,
    'relation',
    candidate,
    validateRelationSemantics,
  );
  if (!validation.valid) {
    throw new RelationCreateError('invalid_relation_document', 'Canonical Relation failed COLP validation.');
  }
  let bytes: number;
  try { bytes = encoder.encode(canonicalJson(candidate)).byteLength; }
  catch { throw new RelationCreateError('invalid_relation_document', 'Canonical Relation must be I-JSON.'); }
  if (bytes > RELATION_MAX_CANDIDATE_BYTES) {
    throw new RelationCreateError('relation_candidate_too_large', 'Canonical Relation exceeds its byte budget.');
  }
}

interface RelationSemanticIssue {
  readonly code: 'custom_label_required';
  readonly message: string;
  readonly path: '/label';
}

function validateRelationSemantics(value: Pick<RelationCreate, 'type' | 'label'>):
  { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly RelationSemanticIssue[] } {
  if (value.type === 'custom' && (!value.label || value.label.trim().length === 0)) {
    return { valid: false, issues: [{ code: 'custom_label_required',
      message: 'A custom Relation requires a non-empty label.', path: '/label' }] };
  }
  return { valid: true, issues: [] };
}

function validEndpoint(value: RelationEndpointFacts | null, collectionId: string): value is RelationEndpointFacts {
  return value !== null && value.collectionId === collectionId && value.deletedAt === null;
}

function authorize(role: MembershipRole | null): void {
  if (role === null) throw new RelationCreateError('relation_not_found', 'Relation Collection was not found.');
  if (role === 'viewer') {
    throw new RelationCreateError('insufficient_relation_permission', 'Relation create requires editor permission.');
  }
}

function assertVisibilityCeiling(requested: RelationVisibility, collection: CollectionVisibility,
  from: RelationVisibility, to: RelationVisibility): void {
  const rank: Record<RelationVisibility, number> = { private: 0, protected: 1, unlisted: 2, public: 3 };
  if (rank[requested] > Math.min(rank[collection], rank[from], rank[to])) {
    throw new RelationCreateError('relation_visibility_too_broad',
      'Relation visibility cannot be broader than its Collection or either endpoint.');
  }
}

function productResult(relation: Readonly<Relation>): ProductCommandResult {
  return { status: 201, body: Buffer.from(canonicalJson(toProductRelationView(relation)), 'utf8'), stableHeaders: {
    'cache-control': 'private, no-store', 'content-type': 'application/json',
    location: `/api/v1/collections/${relation.collectionId}/relations/${relation.id}`,
    etag: `"${relation.revision}"`,
  }, mediaType: 'application/json', contractVersion: CREATE_RELATION_CONTRACT_VERSION,
  targetIdentity: relation.id };
}

function mapClaim(claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>): CreateRelationResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
