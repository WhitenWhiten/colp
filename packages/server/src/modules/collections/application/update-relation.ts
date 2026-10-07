import { createValidatorRegistry, validateWireDocument } from '@know-n/colp/schema';
import type { Relation, RelationMergePatch } from '@know-n/colp/types';
import type { CollectionVisibility, MembershipRole } from '../../access-policy/index.js';
import { assertCanonicalCommandId, canonicalJson, type ProductCommandResult } from '../../commands/index.js';
import {
  assertClosedJsonObject,
  formatUtcDateTime,
  generateOpaqueId,
  type CanonicalMutationInput,
  type JsonObject,
} from '../domain/index.js';
import {
  RELATION_MAX_CANDIDATE_BYTES,
  RELATION_MAX_LABEL_BYTES,
  type CreateRelationPorts,
  type RelationEndpointFacts,
} from './create-relation.js';
import { toProductRelationView } from './get-relation-product.js';

export const UPDATE_RELATION_CONTRACT_VERSION = '1.0.0';
export const RELATION_UPDATED_EVENT_TYPE = 'relation.updated';
export const RELATION_UPDATED_EVENT_VERSION = 1;
export const RELATION_UPDATED_HANDLER_NAME = 'relation_updated_projection';
export const RELATION_MAX_JSON_DEPTH = 16;
export const RELATION_MAX_JSON_MEMBERS = 256;

type RelationVisibility = Relation['visibility'];

export type RelationUpdateErrorCode =
  | 'invalid_relation_input' | 'invalid_relation_patch' | 'invalid_relation_document'
  | 'relation_not_found' | 'relation_precondition_required' | 'invalid_relation_precondition'
  | 'relation_precondition_failed' | 'insufficient_relation_permission'
  | 'relation_visibility_too_broad' | 'relation_already_exists'
  | 'relation_label_too_large' | 'relation_json_too_deep'
  | 'relation_json_too_many_members' | 'relation_candidate_too_large';

export class RelationUpdateError extends Error {
  constructor(readonly code: RelationUpdateErrorCode, message: string, readonly currentEtag?: string) {
    super(message); this.name = 'RelationUpdateError';
  }
}

export type RelationIfMatchEvidence =
  | { readonly kind: 'single-strong-if-match'; readonly entityTag: string; readonly expectedRevision: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'duplicate'; readonly values: readonly string[] };

export interface ProductRelationMergePatch {
  readonly type?: RelationMergePatch['type'];
  readonly label?: string | null;
  readonly visibility?: RelationVisibility;
  readonly extensions?: Readonly<Record<string, unknown>> | null;
}

export interface UpdateRelationInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string; readonly principalType: 'account' };
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope?: string };
  readonly collectionId: string;
  readonly relationId: string;
  readonly precondition: RelationIfMatchEvidence;
  readonly patch: ProductRelationMergePatch;
  readonly operationId?: string;
}

export interface RelationAuthorityRecord {
  readonly relation: Readonly<Relation>;
  readonly deletedAt: Date | null;
}

export interface RelationMutationPorts extends CreateRelationPorts {
  readonly relations: CreateRelationPorts['relations'] & {
    loadAuthoritativeForUpdate(collectionId: string, relationId: string): Promise<RelationAuthorityRecord | null>;
  };
}

export type UpdateRelationResult =
  | { readonly kind: 'updated'; readonly relation: Readonly<Relation>; readonly operationId: string;
      readonly commitOrdinal: bigint }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

interface ValidatedInput extends Omit<UpdateRelationInput, 'command' | 'precondition' | 'patch'> {
  readonly command: { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string };
  readonly precondition: { readonly entityTag: string; readonly expectedRevision: string };
  readonly patch: RelationMergePatch;
}

const validators = createValidatorRegistry();
const encoder = new TextEncoder();
const revisionPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const patchKeys = new Set(['type', 'label', 'visibility', 'extensions']);

export function updateRelationCommandScope(collectionId: string, relationId: string): string {
  return `collection:${collectionId}:relation:${relationId}:update`;
}

export async function updateRelation(
  ports: RelationMutationPorts,
  input: UpdateRelationInput,
): Promise<UpdateRelationResult> {
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
  authorize(role);

  const authority = await ports.relations.loadAuthoritativeForUpdate(validated.collectionId, validated.relationId);
  if (!authority || authority.deletedAt !== null) conceal();
  const current = authority.relation;
  if (current.id !== validated.relationId || current.collectionId !== validated.collectionId) conceal();
  if (current.revision !== validated.precondition.expectedRevision) {
    throw new RelationUpdateError('relation_precondition_failed',
      'Relation changed before this patch was applied.', `"${current.revision}"`);
  }

  const [from, to] = await Promise.all([
    ports.endpoints.resolveLiveEndpoint(validated.collectionId, current.fromNodeId),
    ports.endpoints.resolveLiveEndpoint(validated.collectionId, current.toNodeId),
  ]);
  if (!validEndpoint(from, validated.collectionId) || !validEndpoint(to, validated.collectionId)) conceal();
  const candidate = mergeCandidate(current, validated.patch);
  assertVisibilityCeiling(candidate.visibility, facts.visibility, from.visibility, to.visibility);
  if (candidate.type !== current.type && await ports.relations.hasLiveSemanticEdge(
    validated.collectionId, current.fromNodeId, current.toNodeId, candidate.type,
  )) {
    throw new RelationUpdateError('relation_already_exists', 'The directed semantic Relation already exists.');
  }
  assertBudgets(validated.patch, candidate);
  try {
    assertClosedJsonObject(candidate, 'Canonical Relation');
  } catch {
    throw new RelationUpdateError('invalid_relation_document', 'Canonical Relation must be a closed JSON object.');
  }
  const closed: JsonObject = candidate;
  const extensions = closed.extensions ?? {};
  try {
    assertClosedJsonObject(extensions, 'Canonical Relation extensions');
  } catch {
    throw new RelationUpdateError('invalid_relation_document', 'Canonical Relation must be a closed JSON object.');
  }

  const now = await ports.clock.now();
  const updatedAt = formatUtcDateTime(now);
  const operationId = validated.operationId ?? generateOpaqueId();
  const mutation = await ports.canonical.execute({
    operationId, collectionId: validated.collectionId,
    actor: { principalId: validated.actor.principalId, principalType: validated.actor.principalType },
    mutation: { action: 'update', target: { collectionId: validated.collectionId,
      resourceId: validated.relationId, resourceKind: 'relation' }, parentId: null,
      expectedResourceRevision: current.revision,
      fields: { kindFields: { type: closed.type!, fromNodeId: current.fromNodeId,
        toNodeId: current.toNodeId, ...(closed.label === undefined ? {} : { label: closed.label }),
        visibility: closed.visibility! }, extensions },
      trustedFacts: { createdAt: current.createdAt, updatedAt,
        previousVisibility: current.visibility,
        publicRepresentationChanged: current.visibility !== 'private' || candidate.visibility !== 'private' } },
  });
  const relation = Object.freeze({ ...candidate, updatedAt,
    revision: mutation.allocation.resourceRevision! }) as Readonly<Relation>;
  assertCompleteCandidate(relation);
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult(relation));
  return { kind: 'updated', relation, operationId, commitOrdinal: mutation.allocation.commitOrdinal };
}

function validateInput(input: UpdateRelationInput): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor || !input.command) {
    throw new RelationUpdateError('invalid_relation_input', 'Relation update input is required.');
  }
  for (const value of [input.actor.principalId, input.actor.subjectId, input.collectionId,
    input.relationId, input.command.fingerprint]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RelationUpdateError('invalid_relation_input', 'Relation update identity fields are required.');
    }
  }
  if (input.actor.principalType !== 'account') {
    throw new RelationUpdateError('invalid_relation_input', 'Relation update requires an account actor.');
  }
  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.command.commandId); }
  catch { throw new RelationUpdateError('invalid_relation_input', 'commandId must be a canonical UUID v4.'); }
  return { ...input, command: { commandId, fingerprint: input.command.fingerprint,
    commandScope: input.command.commandScope?.trim()
      || updateRelationCommandScope(input.collectionId, input.relationId) },
  precondition: validatePrecondition(input.precondition), patch: validatePatch(input.patch) };
}

export function validateRelationPrecondition(value: RelationIfMatchEvidence | undefined): {
  readonly entityTag: string; readonly expectedRevision: string;
} {
  if (!value || value.kind === 'missing') {
    throw new RelationUpdateError('relation_precondition_required', 'A single strong If-Match is required.');
  }
  if (value.kind !== 'single-strong-if-match') {
    throw new RelationUpdateError('invalid_relation_precondition', 'Duplicate If-Match fields are forbidden.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'entityTag' || keys[1] !== 'expectedRevision' || keys[2] !== 'kind'
    || !revisionPattern.test(value.expectedRevision) || value.entityTag !== `"${value.expectedRevision}"`) {
    throw new RelationUpdateError('invalid_relation_precondition',
      'If-Match must contain exactly one well-formed strong entity-tag.');
  }
  return { entityTag: value.entityTag, expectedRevision: value.expectedRevision };
}

function validatePrecondition(value: RelationIfMatchEvidence | undefined) {
  return validateRelationPrecondition(value);
}

function validatePatch(value: ProductRelationMergePatch): RelationMergePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelationUpdateError('invalid_relation_patch', 'Relation merge patch must be an object.');
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !patchKeys.has(key))) {
    throw new RelationUpdateError('invalid_relation_patch',
      'Relation merge patch is empty or contains an immutable property.');
  }
  const structural = validators.validate('relationMergePatch', value);
  if (!structural.valid) {
    throw new RelationUpdateError('invalid_relation_document', 'Relation merge patch failed COLP validation.');
  }
  return structuredClone(value) as RelationMergePatch;
}

function mergeCandidate(current: Readonly<Relation>, patch: RelationMergePatch): Readonly<Relation> {
  const next: Record<string, unknown> = { ...current };
  for (const key of patchKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key as keyof RelationMergePatch];
    if (value === null) delete next[key];
    else next[key] = structuredClone(value);
  }
  const candidate = Object.freeze(next) as Readonly<Relation>;
  assertCompleteCandidate(candidate);
  return candidate;
}

function assertCompleteCandidate(candidate: Readonly<Relation>): void {
  const result = validateWireDocument<Relation, RelationSemanticIssue>(
    validators, 'relation', candidate, validateRelationSemantics,
  );
  if (!result.valid) {
    throw new RelationUpdateError('invalid_relation_document', 'Canonical Relation failed COLP validation.');
  }
}

interface RelationSemanticIssue {
  readonly code: 'custom_label_required'; readonly message: string; readonly path: '/label';
}

function validateRelationSemantics(value: Pick<Relation, 'type' | 'label'>):
  { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly RelationSemanticIssue[] } {
  if (value.type === 'custom' && (!value.label || value.label.trim().length === 0)) {
    return { valid: false, issues: [{ code: 'custom_label_required',
      message: 'A custom Relation requires a non-empty label.', path: '/label' }] };
  }
  return { valid: true, issues: [] };
}

function assertBudgets(patch: RelationMergePatch, candidate: Readonly<Relation>): void {
  if (candidate.label !== undefined && encoder.encode(candidate.label).byteLength > RELATION_MAX_LABEL_BYTES) {
    throw new RelationUpdateError('relation_label_too_large', 'Relation label exceeds its byte budget.');
  }
  const patchShape = jsonShape(patch); const candidateShape = jsonShape(candidate);
  if (patchShape.depth > RELATION_MAX_JSON_DEPTH || candidateShape.depth > RELATION_MAX_JSON_DEPTH) {
    throw new RelationUpdateError('relation_json_too_deep', 'Relation update exceeds JSON depth budget.');
  }
  if (patchShape.members > RELATION_MAX_JSON_MEMBERS || candidateShape.members > RELATION_MAX_JSON_MEMBERS) {
    throw new RelationUpdateError('relation_json_too_many_members', 'Relation update exceeds JSON member budget.');
  }
  let bytes: number;
  try { bytes = encoder.encode(canonicalJson(candidate)).byteLength; }
  catch { throw new RelationUpdateError('invalid_relation_document', 'Relation update must be I-JSON.'); }
  if (bytes > RELATION_MAX_CANDIDATE_BYTES) {
    throw new RelationUpdateError('relation_candidate_too_large', 'Canonical Relation exceeds byte budget.');
  }
}

function jsonShape(value: unknown, depth = 0): { depth: number; members: number } {
  if (value === null || typeof value !== 'object') return { depth, members: 0 };
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  let maxDepth = depth + 1; let members = children.length;
  for (const child of children) { const nested = jsonShape(child, depth + 1);
    maxDepth = Math.max(maxDepth, nested.depth); members += nested.members; }
  return { depth: maxDepth, members };
}

function validEndpoint(value: RelationEndpointFacts | null, collectionId: string): value is RelationEndpointFacts {
  return value !== null && value.collectionId === collectionId && value.deletedAt === null;
}

function authorize(role: MembershipRole | null): void {
  if (role === null) conceal();
  if (role === 'viewer') throw new RelationUpdateError('insufficient_relation_permission',
    'Relation update requires editor permission.');
}

function assertVisibilityCeiling(requested: RelationVisibility, collection: CollectionVisibility,
  from: RelationVisibility, to: RelationVisibility): void {
  const rank: Record<RelationVisibility, number> = { private: 0, protected: 1, unlisted: 2, public: 3 };
  if (rank[requested] > Math.min(rank[collection], rank[from], rank[to])) {
    throw new RelationUpdateError('relation_visibility_too_broad',
      'Relation visibility cannot be broader than its Collection or either endpoint.');
  }
}

function conceal(): never {
  throw new RelationUpdateError('relation_not_found', 'Relation was not found.');
}

function productResult(relation: Readonly<Relation>): ProductCommandResult {
  return { status: 200, body: Buffer.from(canonicalJson(toProductRelationView(relation)), 'utf8'), stableHeaders: {
    'cache-control': 'private, no-store', 'content-type': 'application/json',
    location: `/api/v1/collections/${relation.collectionId}/relations/${relation.id}`,
    etag: `"${relation.revision}"` }, mediaType: 'application/json',
  contractVersion: UPDATE_RELATION_CONTRACT_VERSION, targetIdentity: relation.id };
}

function mapClaim(claim: Exclude<Awaited<ReturnType<RelationMutationPorts['receipts']['claim']>>,
  { kind: 'claimed' }>): UpdateRelationResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

export interface RelationUpdatedPayload extends JsonObject {
  readonly collectionId: string; readonly relationId: string; readonly fromNodeId: string;
  readonly toNodeId: string; readonly type: Relation['type']; readonly visibility: RelationVisibility;
  readonly previousVisibility: RelationVisibility; readonly publicRepresentationChanged: boolean;
  readonly resourceRevision: string; readonly contentRevision: string;
}
