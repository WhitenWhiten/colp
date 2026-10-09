import type { Relation } from '@know-n/colp/types';
import type { AccessPolicyFactsPort, ResourcePolicyFacts } from '../../access-policy/index.js';
import { formatUtcDateTime } from '../domain/index.js';
import { RelationCursorError, PRODUCT_RELATION_COMPARATOR_VERSION, PRODUCT_RELATION_CURSOR_PURPOSE,
  PRODUCT_RELATION_CURSOR_TTL_MS, PRODUCT_RELATION_CURSOR_VERSION,
  type ProductRelationCursorAfter, type ProductRelationCursorSignerPort } from './relation-cursor.js';
import type { CollectionsClock } from './ports.js';

export const RELATION_PAGE_DEFAULT_LIMIT = 20;
export const RELATION_PAGE_MAX_LIMIT = 100;
export type ProductRelationDirection = 'incoming' | 'outgoing' | 'both';
const relationTypes = new Set<Relation['type']>(['related', 'precedes', 'follows', 'supports', 'contradicts',
  'duplicate_of', 'derived_from', 'mentions', 'custom']);
const relationVisibilities = new Set<Relation['visibility']>(['private', 'protected', 'unlisted', 'public']);

export interface ProductRelationRow {
  readonly id: string; readonly collectionId: string; readonly fromNodeId: string; readonly toNodeId: string;
  readonly payload: Readonly<Relation>; readonly resourceRevision: string;
  readonly updatedAt: Date; readonly deletedAt: Date | null;
  readonly fromVisibility?: ProductRelationNodeRow['visibility'];
  readonly toVisibility?: ProductRelationNodeRow['visibility'];
}
export interface ProductRelationNodeRow {
  readonly id: string; readonly collectionId: string;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
}
export interface ProductRelationReadPort {
  loadLiveNode(input: { collectionId: string; nodeId: string }): Promise<ProductRelationNodeRow | null>;
  loadLiveById(input: { collectionId: string; relationId: string }): Promise<ProductRelationRow | null>;
  listLiveByNode(input: { collectionId: string; nodeId: string; direction: Exclude<ProductRelationDirection, 'both'>;
    types: readonly Relation['type'][]; visibilities: readonly Relation['visibility'][];
    endpointVisibilities: readonly ProductRelationNodeRow['visibility'][];
    limit: number; after?: ProductRelationCursorAfter }): Promise<readonly ProductRelationRow[]>;
}
export interface ProductRelationReadPorts {
  readonly reads: ProductRelationReadPort; readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursorSigner: ProductRelationCursorSignerPort; readonly clock: CollectionsClock; readonly cursorTtlMs?: number;
}
export interface RelationReadUnitOfWork {
  execute<Result>(work: (ports: ProductRelationReadPorts) => Promise<Result>): Promise<Result>;
}
export interface ProductRelationView {
  readonly id: string; readonly collectionId: string; readonly fromNodeId: string; readonly toNodeId: string;
  readonly type: Relation['type']; readonly label: string | null; readonly visibility: Relation['visibility'];
  readonly revision: string; readonly createdAt: string; readonly updatedAt: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}
export interface ProductRelationPage {
  readonly relations: readonly ProductRelationView[];
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}
export class RelationProductReadError extends Error {
  constructor(readonly code: 'relation_not_found' | 'invalid_relation_query' | 'invalid_cursor') {
    super(code === 'relation_not_found' ? 'The requested resource was not found.' : 'The Relation query is invalid.');
    this.name = 'RelationProductReadError';
  }
}

export async function getProductRelation(ports: ProductRelationReadPorts, input: {
  collectionId: string; relationId: string; actor: { principalId: string; subjectId: string };
}): Promise<ProductRelationView> {
  identity(input.collectionId, input.relationId, input.actor.principalId, input.actor.subjectId);
  const row = await ports.reads.loadLiveById({ collectionId: input.collectionId, relationId: input.relationId });
  if (!row || row.deletedAt !== null) throw notFound();
  const facts = await factsFor(ports, input.collectionId, input.actor.subjectId);
  const [from, to] = await Promise.all([
    ports.reads.loadLiveNode({ collectionId: input.collectionId, nodeId: row.fromNodeId }),
    ports.reads.loadLiveNode({ collectionId: input.collectionId, nodeId: row.toNodeId }),
  ]);
  if (!from || !to || !canRead(row, facts, input.actor.subjectId, from, to)) throw notFound();
  return toProductRelationView(row.payload, !isMemberProjection(facts, input.actor.subjectId));
}

export async function getProductRelationPage(ports: ProductRelationReadPorts, input: {
  collectionId: string; nodeId: string; direction: ProductRelationDirection;
  actor: { principalId: string; subjectId: string }; types?: readonly Relation['type'][];
  visibilities?: readonly Relation['visibility'][]; limit?: number; cursor?: string;
}): Promise<ProductRelationPage> {
  identity(input.collectionId, input.nodeId, input.actor.principalId, input.actor.subjectId);
  const direction = directionOf(input.direction); const types = normalized(input.types ?? [], relationTypes);
  const visibilities = normalized(input.visibilities ?? [], relationVisibilities);
  if (input.cursor !== undefined && input.limit !== undefined) throw invalidQuery();
  const now = await ports.clock.now(); let limit: number; let after: ProductRelationCursorAfter | undefined;
  let issuedAt: string; let expiresAt: string; let cursorPolicyRevision: string | undefined;
  if (input.cursor !== undefined) {
    let cursor; try { cursor = ports.cursorSigner.verify(input.cursor, now); }
    catch (error) { if (error instanceof RelationCursorError) throw invalidCursor(); throw error; }
    if (cursor.principalId !== input.actor.principalId || cursor.collectionId !== input.collectionId
      || cursor.nodeId !== input.nodeId || cursor.direction !== direction || cursor.scope !== 'product-visible'
      || !same(cursor.types, types) || !same(cursor.visibilities, visibilities)) throw invalidCursor();
    ({ limit, after, issuedAt, expiresAt } = cursor); cursorPolicyRevision = cursor.policyRevision;
  } else {
    limit = normalizeLimit(input.limit); issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + (ports.cursorTtlMs ?? PRODUCT_RELATION_CURSOR_TTL_MS)));
  }
  const node = await ports.reads.loadLiveNode({ collectionId: input.collectionId, nodeId: input.nodeId });
  if (!node) throw notFound();
  const facts = await factsFor(ports, input.collectionId, input.actor.subjectId);
  if (cursorPolicyRevision !== undefined && cursorPolicyRevision !== facts.policyRevision) throw invalidCursor();
  if (!nodeVisible(node, facts, input.actor.subjectId)) throw notFound();
  const permitted = permittedVisibilities(facts, input.actor.subjectId);
  const effectiveVisibilities = visibilities.length === 0
    ? permitted : visibilities.filter((visibility) => permitted.includes(visibility));
  const endpointVisibilities = permittedEndpointVisibilities(facts, input.actor.subjectId);
  const directions: Array<'incoming' | 'outgoing'> = direction === 'both' ? ['incoming', 'outgoing'] : [direction];
  const branches = await Promise.all(directions.map((branch) => ports.reads.listLiveByNode({
    collectionId: input.collectionId, nodeId: input.nodeId, direction: branch, types,
    visibilities: effectiveVisibilities, endpointVisibilities, limit, ...(after ? { after } : {}),
  })));
  const merged = [...new Map(branches.flat().map((row) => [row.id, row])).values()]
    .filter((row) => canRead(row, facts, input.actor.subjectId))
    .sort(compareRows);
  const visible = merged.slice(0, limit); const hasMore = merged.length > limit; const last = visible.at(-1);
  const nextCursor = hasMore && last ? ports.cursorSigner.sign({
    v: PRODUCT_RELATION_CURSOR_VERSION, purpose: PRODUCT_RELATION_CURSOR_PURPOSE,
    principalId: input.actor.principalId, collectionId: input.collectionId, nodeId: input.nodeId,
    direction, types, visibilities, scope: 'product-visible', limit,
    comparatorVersion: PRODUCT_RELATION_COMPARATOR_VERSION, policyRevision: facts.policyRevision,
    after: { updatedAt: formatUtcDateTime(last.updatedAt), id: last.id }, issuedAt, expiresAt,
  }) : null;
  const publicProjection = !isMemberProjection(facts, input.actor.subjectId);
  return Object.freeze({ relations: Object.freeze(visible.map((row) => toProductRelationView(row.payload, publicProjection))),
    page: Object.freeze({ returnedCount: visible.length, hasMore, nextCursor }) });
}

export function toProductRelationView(
  payload: Readonly<Relation>,
  publicProjection = false,
): ProductRelationView {
  return Object.freeze({ id: payload.id, collectionId: payload.collectionId, fromNodeId: payload.fromNodeId,
    toNodeId: payload.toNodeId, type: payload.type, label: payload.label ?? null,
    visibility: payload.visibility, revision: payload.revision, createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    // Relation extension namespaces may contain internal graph metadata. Keep
    // them for members/owners, but use an empty public projection for outsiders.
    extensions: Object.freeze(publicProjection ? {} : { ...(payload.extensions ?? {}) }) });
}

async function factsFor(ports: ProductRelationReadPorts, collectionId: string, subjectId: string) {
  const facts = await ports.accessPolicy.loadCollectionFacts({ collectionId, actorSubjectId: subjectId });
  if (!facts || facts.deleted || !collectionVisible(facts, subjectId)) throw notFound(); return facts;
}
function isMemberProjection(facts: ResourcePolicyFacts, actorSubjectId: string): boolean {
  return facts.ownerSubjectId === actorSubjectId || facts.membershipRole !== null;
}
function collectionVisible(facts: ResourcePolicyFacts, subjectId: string) {
  return facts.ownerSubjectId === subjectId || facts.membershipRole !== null
    || facts.visibility === 'public' || facts.visibility === 'unlisted';
}
function nodeVisible(node: ProductRelationNodeRow, facts: ResourcePolicyFacts, subjectId: string) {
  return facts.ownerSubjectId === subjectId || facts.membershipRole !== null
    || node.visibility === 'public' || node.visibility === 'unlisted';
}
function permittedVisibilities(facts: ResourcePolicyFacts, subjectId: string): Relation['visibility'][] {
  if (facts.ownerSubjectId === subjectId || facts.membershipRole === 'owner' || facts.membershipRole === 'editor')
    return ['private', 'protected', 'unlisted', 'public'];
  if (facts.membershipRole !== null) return ['protected', 'unlisted', 'public'];
  return ['unlisted', 'public'];
}
function permittedEndpointVisibilities(facts: ResourcePolicyFacts, subjectId: string): ProductRelationNodeRow['visibility'][] {
  if (facts.ownerSubjectId === subjectId || facts.membershipRole !== null)
    return ['private', 'protected', 'unlisted', 'public'];
  return ['unlisted', 'public'];
}
function canRead(row: ProductRelationRow, facts: ResourcePolicyFacts, subjectId: string,
  from?: ProductRelationNodeRow, to?: ProductRelationNodeRow) {
  if (row.deletedAt !== null || row.collectionId !== facts.collectionId || row.payload.id !== row.id
    || row.payload.collectionId !== row.collectionId || row.payload.fromNodeId !== row.fromNodeId
    || row.payload.toNodeId !== row.toNodeId || row.payload.revision !== row.resourceRevision) return false;
  if (from && to && (!nodeVisible(from, facts, subjectId) || !nodeVisible(to, facts, subjectId))) return false;
  if (row.fromVisibility && row.toVisibility
    && (!nodeVisible({ id: row.fromNodeId, collectionId: row.collectionId, visibility: row.fromVisibility }, facts, subjectId)
      || !nodeVisible({ id: row.toNodeId, collectionId: row.collectionId, visibility: row.toVisibility }, facts, subjectId))) return false;
  return permittedVisibilities(facts, subjectId).includes(row.payload.visibility);
}
function compareRows(left: ProductRelationRow, right: ProductRelationRow) {
  return right.updatedAt.getTime() - left.updatedAt.getTime() || Buffer.from(left.id).compare(Buffer.from(right.id));
}
function normalizeLimit(value: number | undefined) {
  if (value === undefined) return RELATION_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > RELATION_PAGE_MAX_LIMIT) throw invalidQuery(); return value;
}
function directionOf(value: unknown): ProductRelationDirection {
  if (value !== 'incoming' && value !== 'outgoing' && value !== 'both') throw invalidQuery(); return value;
}
function normalized<T extends string>(values: readonly T[], allowed: ReadonlySet<T>): readonly T[] {
  if (!Array.isArray(values) || new Set(values).size !== values.length
    || values.some((value) => !allowed.has(value))) throw invalidQuery();
  return Object.freeze([...values].sort((a, b) => a.localeCompare(b, 'en')));
}
function same(left: readonly string[], right: readonly string[]) { return left.length === right.length && left.every((v, i) => v === right[i]); }
function identity(...values: string[]) { if (values.some((value) => !value || value !== value.trim())) throw invalidQuery(); }
function notFound() { return new RelationProductReadError('relation_not_found'); }
function invalidQuery() { return new RelationProductReadError('invalid_relation_query'); }
function invalidCursor() { return new RelationProductReadError('invalid_cursor'); }
