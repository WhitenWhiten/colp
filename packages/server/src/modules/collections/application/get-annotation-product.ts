import type { Annotation } from '@know-n/colp/types';
import type { AccessPolicyFactsPort, ResourcePolicyFacts } from '../../access-policy/index.js';
import { formatUtcDateTime } from '../domain/index.js';
import {
  AnnotationCursorError,
  PRODUCT_ANNOTATION_COMPARATOR_VERSION,
  PRODUCT_ANNOTATION_CURSOR_PURPOSE,
  PRODUCT_ANNOTATION_CURSOR_TTL_MS,
  PRODUCT_ANNOTATION_CURSOR_VERSION,
  type ProductAnnotationCursorAfter,
  type ProductAnnotationCursorSignerPort,
} from './annotation-cursor.js';
import type { CollectionsClock } from './ports.js';

export const ANNOTATION_PAGE_DEFAULT_LIMIT = 20;
export const ANNOTATION_PAGE_MAX_LIMIT = 100;

export interface ProductAnnotationRow {
  readonly id: string;
  readonly collectionId: string;
  readonly subjectType: 'collection' | 'node';
  readonly subjectId: string;
  readonly creatorPrincipalId: string;
  readonly payload: Readonly<Annotation>;
  readonly resourceRevision: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface ProductAnnotationSubjectRow {
  readonly type: 'collection' | 'node';
  readonly id: string;
  readonly collectionId: string;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
}

export interface ProductAnnotationReadPort {
  collectionNotesRevision?(collectionId: string): Promise<string | null>;
  listPrivateCollectionNotes?(input: { collectionId: string; principalId: string; limit: number; after?: ProductAnnotationCursorAfter }): Promise<readonly ProductAnnotationRow[]>;
  loadLiveSubject(input: {
    collectionId: string; resourceType: 'collection' | 'node'; resourceId: string;
  }): Promise<ProductAnnotationSubjectRow | null>;
  loadLiveById(input: { collectionId: string; annotationId: string }): Promise<ProductAnnotationRow | null>;
  listLiveBySubject(input: {
    collectionId: string; resourceType: 'collection' | 'node'; resourceId: string;
    principalId: string; includeProtected: boolean; limit: number; after?: ProductAnnotationCursorAfter;
  }): Promise<readonly ProductAnnotationRow[]>;
}

export interface ProductAnnotationReadPorts {
  readonly reads: ProductAnnotationReadPort;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursorSigner: ProductAnnotationCursorSignerPort;
  readonly clock: CollectionsClock;
  readonly cursorTtlMs?: number;
}

export interface AnnotationReadUnitOfWork {
  execute<Result>(work: (ports: ProductAnnotationReadPorts) => Promise<Result>): Promise<Result>;
}

export interface ProductAnnotationView {
  readonly id: string;
  readonly collectionId: string;
  readonly subject: Readonly<{ type: 'collection' | 'node'; id: string }>;
  readonly type: Annotation['type'];
  readonly format: Annotation['format'] | null;
  readonly value: unknown;
  readonly visibility: Annotation['visibility'];
  readonly creator: Annotation['creator'] | null;
  readonly provenance: Readonly<{
    readonly kind: 'human' | 'ai' | 'imported' | 'derived';
    readonly provider?: string;
    readonly model?: string;
    readonly generatedAt?: string;
    readonly editedByHuman?: boolean;
    readonly sourceNodeIds?: readonly string[];
  }> | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ProductAnnotationPage {
  readonly annotations: readonly ProductAnnotationView[];
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}

export class AnnotationProductReadError extends Error {
  constructor(readonly code: 'annotation_not_found' | 'invalid_annotation_query' | 'invalid_cursor') {
    super(code === 'annotation_not_found' ? 'The requested resource was not found.' : 'The Annotation query is invalid.');
    this.name = 'AnnotationProductReadError';
  }
}

export async function getProductAnnotation(
  ports: ProductAnnotationReadPorts,
  input: { collectionId: string; annotationId: string; actor: { principalId: string; subjectId: string } },
): Promise<ProductAnnotationView> {
  assertIdentity(input.collectionId, input.annotationId, input.actor.principalId, input.actor.subjectId);
  const row = await ports.reads.loadLiveById({ collectionId: input.collectionId, annotationId: input.annotationId });
  if (!row || row.deletedAt !== null) throw notFound();
  const subject = await ports.reads.loadLiveSubject({
    collectionId: input.collectionId, resourceType: row.subjectType, resourceId: row.subjectId,
  });
  if (!subject) throw notFound();
  const facts = await loadAccessibleFacts(ports, input.collectionId, input.actor.subjectId);
  if (!subjectAccessible(subject, facts, input.actor.subjectId)
    || !canRead(row, facts, subject, input.actor.principalId, input.actor.subjectId)) throw notFound();
  return mapRow(row);
}

export async function getProductAnnotationPage(
  ports: ProductAnnotationReadPorts,
  input: {
    collectionId: string; resourceType: 'collection' | 'node'; resourceId: string;
    actor: { principalId: string; subjectId: string }; limit?: number; cursor?: string;
  },
): Promise<ProductAnnotationPage> {
  assertIdentity(input.collectionId, input.resourceId, input.actor.principalId, input.actor.subjectId);
  if (input.cursor !== undefined && input.limit !== undefined) throw invalidQuery();
  const now = await ports.clock.now();
  let limit: number;
  let after: ProductAnnotationCursorAfter | undefined;
  let issuedAt: string;
  let expiresAt: string;
  let cursorPolicyRevision: string | undefined;
  if (input.cursor !== undefined) {
    let cursor;
    try { cursor = ports.cursorSigner.verify(input.cursor, now); }
    catch (error) { if (error instanceof AnnotationCursorError) throw invalidCursor(); throw error; }
    if (cursor.principalId !== input.actor.principalId || cursor.collectionId !== input.collectionId
      || cursor.resourceType !== input.resourceType || cursor.resourceId !== input.resourceId
      || cursor.scope !== 'product-visible') throw invalidCursor();
    ({ limit, after, issuedAt, expiresAt } = cursor);
    cursorPolicyRevision = cursor.policyRevision;
  } else {
    limit = normalizeLimit(input.limit);
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + (ports.cursorTtlMs ?? PRODUCT_ANNOTATION_CURSOR_TTL_MS)));
  }
  const subject = await ports.reads.loadLiveSubject({ collectionId: input.collectionId,
    resourceType: input.resourceType, resourceId: input.resourceId });
  if (!subject) throw notFound();
  const facts = await loadAccessibleFacts(ports, input.collectionId, input.actor.subjectId);
  if (cursorPolicyRevision !== undefined && cursorPolicyRevision !== facts.policyRevision) {
    throw invalidCursor();
  }
  if (!subjectAccessible(subject, facts, input.actor.subjectId)) throw notFound();
  const loaded = await ports.reads.listLiveBySubject({ collectionId: input.collectionId,
    resourceType: input.resourceType, resourceId: input.resourceId, principalId: input.actor.principalId,
    includeProtected: facts.ownerSubjectId === input.actor.subjectId || facts.membershipRole !== null,
    limit, ...(after ? { after } : {}) });
  const authorized = loaded.filter((row) => canRead(
    row, facts, subject, input.actor.principalId, input.actor.subjectId,
  ));
  const visible = authorized.slice(0, limit);
  const hasMore = authorized.length > limit;
  const last = visible.at(-1);
  const nextCursor = hasMore && last ? ports.cursorSigner.sign({
    v: PRODUCT_ANNOTATION_CURSOR_VERSION, purpose: PRODUCT_ANNOTATION_CURSOR_PURPOSE,
    principalId: input.actor.principalId, collectionId: input.collectionId,
    resourceType: input.resourceType, resourceId: input.resourceId, scope: 'product-visible', limit,
    comparatorVersion: PRODUCT_ANNOTATION_COMPARATOR_VERSION, policyRevision: facts.policyRevision,
    after: { updatedAt: formatUtcDateTime(last.updatedAt), id: last.id }, issuedAt, expiresAt,
  }) : null;
  return Object.freeze({ annotations: Object.freeze(visible.map(mapRow)), page: Object.freeze({
    returnedCount: visible.length, hasMore, nextCursor,
  }) });
}

async function loadAccessibleFacts(ports: ProductAnnotationReadPorts, collectionId: string, subjectId: string) {
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId, actorSubjectId: subjectId });
  if (!facts || facts.deleted || !collectionVisible(facts, subjectId)) throw notFound();
  return facts;
}

function collectionVisible(facts: ResourcePolicyFacts, actorSubjectId: string): boolean {
  return actorSubjectId === facts.ownerSubjectId || facts.membershipRole !== null
    || facts.visibility === 'public' || facts.visibility === 'unlisted';
}

function subjectAccessible(
  subject: ProductAnnotationSubjectRow,
  facts: ResourcePolicyFacts,
  actorSubjectId: string,
): boolean {
  return facts.ownerSubjectId === actorSubjectId || facts.membershipRole !== null
    || subject.visibility === 'public' || subject.visibility === 'unlisted';
}

function canRead(row: ProductAnnotationRow, facts: ResourcePolicyFacts,
  subject: ProductAnnotationSubjectRow, principalId: string, actorSubjectId: string): boolean {
  if (row.collectionId !== facts.collectionId || row.subjectType !== subject.type || row.subjectId !== subject.id
    || row.payload.id !== row.id || row.payload.collectionId !== row.collectionId
    || row.payload.subject.type !== row.subjectType || row.payload.subject.id !== row.subjectId
    || row.payload.revision !== row.resourceRevision || row.deletedAt !== null) return false;
  if (row.payload.visibility === 'private') return row.creatorPrincipalId === principalId;
  const member = facts.membershipRole !== null;
  const owner = facts.ownerSubjectId === actorSubjectId;
  if (row.payload.visibility === 'protected') return member || owner;
  if (subject.visibility === 'private' || subject.visibility === 'protected') return member || owner;
  return true;
}

export function toProductAnnotationView(payload: Readonly<Annotation>): ProductAnnotationView {
  return Object.freeze({
    id: payload.id, collectionId: payload.collectionId,
    subject: Object.freeze({ type: payload.subject.type, id: payload.subject.id }),
    type: payload.type, format: payload.format ?? null, value: payload.value,
    visibility: payload.visibility,
    creator: payload.creator ? Object.freeze({ id: payload.creator.id, name: payload.creator.name }) : null,
    provenance: payload.provenance ? Object.freeze({
      kind: payload.provenance.kind,
      ...(payload.provenance.provider !== undefined ? { provider: payload.provenance.provider } : {}),
      ...(payload.provenance.model !== undefined ? { model: payload.provenance.model } : {}),
      ...(payload.provenance.generatedAt !== undefined
        ? { generatedAt: payload.provenance.generatedAt }
        : {}),
      ...(payload.provenance.sourceNodeIds !== undefined
        ? { sourceNodeIds: Object.freeze([...payload.provenance.sourceNodeIds]) }
        : {}),
      ...(payload.provenance.editedByHuman !== undefined
        ? { editedByHuman: payload.provenance.editedByHuman }
        : {}),
    }) : null,
    revision: payload.revision,
    createdAt: payload.createdAt, updatedAt: payload.updatedAt,
    extensions: Object.freeze({ ...(payload.extensions ?? {}) }),
  });
}

function mapRow(row: ProductAnnotationRow): ProductAnnotationView {
  return toProductAnnotationView(row.payload);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return ANNOTATION_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ANNOTATION_PAGE_MAX_LIMIT) throw invalidQuery();
  return limit;
}
function assertIdentity(...values: string[]): void {
  if (values.some((value) => typeof value !== 'string' || value.length === 0 || value !== value.trim())) {
    throw invalidQuery();
  }
}
function notFound() { return new AnnotationProductReadError('annotation_not_found'); }
function invalidQuery() { return new AnnotationProductReadError('invalid_annotation_query'); }
function invalidCursor() { return new AnnotationProductReadError('invalid_cursor'); }
