import { createHash } from 'node:crypto';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateSnapshotSemantics } from '@know-n/colp/semantic';
import {
  assertPublicationSnapshotBookmarkUrls,
  projectPublicationPublicWire,
} from '@know-n/colp/server';
import type { Annotation, Attachment, HttpUrl, Relation, Snapshot, SnapshotNode } from '@know-n/colp/types';
import type { AccessPolicyFactsPort } from '../../access-policy/index.js';
import {
  assertSharedExposureIneligible,
  assessSharedExposureScope,
  type SharedExposureEligibility,
  type SharedExposureFactsPort,
} from '../../exposure/index.js';
import {
  isHiddenPublicCollection,
  isRestrictedPublicCollection,
  type CollectionHideControlPort,
} from './collection-control-gate.js';
import { PUBLIC_NODE_EXTENSIONS, PUBLICATION_PRODUCER_SEMANTICS, publicBookmarkExtensions } from './publication-node-extensions.js';
import type { PublicationCursorKeyring } from './cursor-keyring.js';
import {
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  PublicationSnapshotAnchorNotFoundError,
} from './snapshot-read.js';
import type {
  PublicationAnnotationReadPage,
  PublicationAnnotationReadPort,
  PublicationAnnotationRecord,
  PublicationCollectionRecord,
  PublicationNodeRecord,
  PublicationRelationReadPage,
  PublicationRelationReadPort,
  PublicationRelationRecord,
  PublicationSnapshotReadPort,
} from './snapshot-read.js';
import { isPubliclyVisible, moderationTombstoneRef, type ModerationHiddenBookmarkRef } from './snapshot-read.js';

export const PUBLICATION_SNAPSHOT_DEFAULT_LIMIT = 200;
export const PUBLICATION_SNAPSHOT_MAX_LIMIT = 500;
export const PUBLICATION_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const PUBLICATION_SNAPSHOT_CURSOR_TTL_MS = 15 * 60 * 1000;

export type PublicationPrincipal =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly principalId: string; readonly subjectId: string };

export interface PublicationSnapshotQueryInput {
  readonly collectionId: string;
  readonly principal: PublicationPrincipal;
  readonly query?: Readonly<{
    readonly root?: string;
    readonly depth?: number;
    readonly include?: readonly ('annotations' | 'attachments' | 'relations')[];
    readonly limit?: number;
    readonly pageCursor?: string;
  }>;
}

export interface PublicationSnapshotQueryPorts {
  readonly reads: PublicationSnapshotReadPort;
  readonly annotations?: PublicationAnnotationReadPort;
  readonly relations?: PublicationRelationReadPort;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly cursors: PublicationCursorKeyring;
  readonly origin: string;
  readonly now?: () => Date;
  /**
   * P4A-R06: the Publication projection depends on the exposure-eligibility
   * gate through the approved facts port (logical facts only). Every blob in
   * the collection scope is assessed; deny-by-default means the snapshot
   * attachment projection is empty BY the gate verdict, never by a missing
   * schema field.
   */
  readonly sharedExposure: SharedExposureFactsPort;
  readonly collectionControl?: CollectionHideControlPort;
}

export interface PublicationSnapshotPageResult {
  readonly snapshot: Readonly<Snapshot>;
  /** Internal authority fact. It is never included in the Publication wire snapshot. */
  readonly ownerSubjectId: string;
  readonly projection: 'public' | 'member';
  readonly nextCursor: string | null;
  readonly byteLength: number;
  /** Bare locators of hide_public-dropped bookmarks for product-page tombstones; absent when nothing is hidden. The COLP wire keeps omitting them. */
  readonly moderationHiddenBookmarks?: readonly ModerationHiddenBookmarkRef[];
}

export class PublicationSnapshotExpiredError extends Error {
  readonly code = 'snapshot_expired';
  constructor() {
    super('Publication Snapshot continuation no longer matches its revision or request scope.');
    this.name = 'PublicationSnapshotExpiredError';
  }
}

export class PublicationNotFoundError extends Error {
  readonly code = 'resource_not_found';
  constructor() {
    super('Publication Collection was not found.');
    this.name = 'PublicationNotFoundError';
  }
}

const validators = createValidatorRegistry();

/** Full COLP schema, URL and semantic guard shared with the Redis hit path. */
export function isValidPublicationSnapshot(value: unknown): value is Snapshot {
  const structural = validators.validate('snapshot', value);
  if (!structural.valid) return false;
  try {
    assertPublicationSnapshotBookmarkUrls(value as Snapshot);
  } catch {
    return false;
  }
  return validateSnapshotSemantics(value as Snapshot, PUBLICATION_PRODUCER_SEMANTICS).valid;
}

interface StreamStep {
  readonly stream: 'nodes' | 'annotations' | 'relations';
  readonly locator: string;
  readonly node: SnapshotNode | null;
  readonly tombstone?: ModerationHiddenBookmarkRef | null;
  readonly annotation: Annotation | null;
  readonly relation: Relation | null;
}

interface ContinuationPoint {
  readonly stream: 'nodes' | 'annotations' | 'relations';
  readonly afterLocator?: string;
}

export async function getPublicationSnapshotPage(
  ports: PublicationSnapshotQueryPorts,
  input: PublicationSnapshotQueryInput,
  signal?: AbortSignal,
): Promise<PublicationSnapshotPageResult> {
  const query = normalizePublicationSnapshotQuery(input.query);
  const includesAnnotations = query.include.includes('annotations');
  const includesRelations = query.include.includes('relations');
  const cursorContextBase = {
    collectionId: input.collectionId,
    resourceId: `${ports.origin}/colp/v0.1/collections/${encodeURIComponent(input.collectionId)}/snapshot`,
    principal: principalScope(input.principal),
    ...(query.root ? { root: query.root } : {}),
    ...(query.depth !== undefined ? { depth: query.depth } : {}),
    ...(query.include.length > 0 ? { include: query.include } : {}),
    pageSize: query.limit,
  };
  const nowMs = (ports.now?.() ?? new Date()).getTime();
  let cursorExpiresAt = Math.floor(nowMs / 60_000) * 60_000 + PUBLICATION_SNAPSHOT_CURSOR_TTL_MS;
  let sequence = 1;
  let stream: Continuation['stream'] = 'nodes';
  let afterLocator: string | undefined;
  const isContinuation = query.pageCursor !== undefined;
  const capacity = isContinuation ? query.limit : query.limit - 1;
  if (capacity < 0) throw new RangeError('Publication Snapshot limit cannot fit the first-page Root');

  // Continuations first load only current fence facts. The signed stream state
  // then selects one candidate reader without rescanning a completed stream.
  let read = await ports.reads.loadPage({
    collectionId: input.collectionId,
    limit: Math.max(1, capacity),
    ...(isContinuation || input.principal.kind !== 'anonymous' ? { metadataOnly: true } : {}),
    ...(query.root ? { rootId: query.root } : {}),
    ...(query.depth !== undefined ? { depth: query.depth } : {}),
    ...(input.principal.kind === 'anonymous' ? { projection: 'public' as const } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  const collection = requireReadableCollection(read.collection, read.root, isContinuation);
  const revision = publicationRevision(collection);
  const comparatorVersion = comparatorScope(read.comparatorVersion, includesAnnotations, includesRelations);
  const projectionSelection = await selectProjection(
    ports.accessPolicy, collection, input.principal, isContinuation,
  );
  const projection = projectionSelection.projection;
  // An authenticated non-member still receives the public projection. Select
  // authorization before the candidate scan so hidden rows never consume slots.
  if (!isContinuation && input.principal.kind !== 'anonymous') {
    read = await ports.reads.loadPage({
      collectionId: input.collectionId,
      limit: Math.max(1, capacity),
      projection,
      ...(query.root ? { rootId: query.root } : {}),
      ...(query.depth !== undefined ? { depth: query.depth } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    const scannedCollection = requireReadableCollection(read.collection, read.root, false);
    if (publicationRevision(scannedCollection) !== revision
      || comparatorScope(read.comparatorVersion, includesAnnotations, includesRelations) !== comparatorVersion) {
      throw new PublicationSnapshotExpiredError();
    }
  }

  if (query.pageCursor !== undefined) {
    const verification = ports.cursors.snapshot.verify(query.pageCursor, {
      revision, comparatorVersion, ...cursorContextBase,
    });
    if (!verification.valid) throw new PublicationSnapshotExpiredError();
    const decoded = decodeContinuation(verification.nextPosition);
    if ((ports.now?.() ?? new Date()).getTime() >= decoded.expiresAt) {
      throw new PublicationSnapshotExpiredError();
    }
    sequence = decoded.sequence;
    stream = decoded.stream;
    afterLocator = decoded.afterLocator;
    cursorExpiresAt = decoded.expiresAt;
    if ((stream === 'annotations' && !includesAnnotations)
      || (stream === 'relations' && !includesRelations)) throw new PublicationSnapshotExpiredError();
    if (stream === 'nodes') {
      try {
        read = await ports.reads.loadPage({
          collectionId: input.collectionId,
          limit: capacity,
          ...(afterLocator ? { afterLocator } : {}),
          ...(query.root ? { rootId: query.root } : {}),
          ...(query.depth !== undefined ? { depth: query.depth } : {}),
          projection,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (error instanceof PublicationSnapshotAnchorNotFoundError) {
          throw new PublicationSnapshotExpiredError();
        }
        throw error;
      }
      const continuedCollection = requireReadableCollection(read.collection, read.root, true);
      if (publicationRevision(continuedCollection) !== revision
        || comparatorScope(read.comparatorVersion, includesAnnotations, includesRelations) !== comparatorVersion) {
        throw new PublicationSnapshotExpiredError();
      }
    }
  }

  if (projection === 'public' && read.root !== null && !isPubliclyVisible(read.root)) {
    if (isContinuation) throw new PublicationSnapshotExpiredError();
    throw new PublicationNotFoundError();
  }
  if (await isHiddenPublicCollection(ports.collectionControl, input.collectionId, projection)) {
    if (isContinuation) throw new PublicationSnapshotExpiredError(); throw new PublicationNotFoundError();
  }
  if (await isRestrictedPublicCollection(ports.collectionControl, input.collectionId, projection)) {
    if (isContinuation) throw new PublicationSnapshotExpiredError(); throw new PublicationNotFoundError();
  }
  // Shared attachments have no content-safety capability. There are no
  // attachment candidates in this projection, so the gate performs no I/O.
  const exposure = await assessSharedExposureScope(ports.sharedExposure, {
    collectionId: input.collectionId, blobIds: [],
  });
  const attachments = projectEligibleSnapshotAttachments(exposure);
  const rootNodes = sequence === 1 && read.root
    && (projection === 'member' || isPubliclyVisible(read.root))
    ? [mapSnapshotNode(read.root)]
    : [];
  const nodeSteps: StreamStep[] = [];
  let nodeHasMore = false;
  if (stream === 'nodes') {
    const consumed = Math.min(capacity, read.candidates.length);
    nodeHasMore = read.candidates.length > consumed;
    for (const row of read.candidates.slice(0, consumed)) {
      nodeSteps.push(Object.freeze({
        stream: 'nodes', locator: nodeLocatorOf(row),
        node: projection === 'member' || (isPubliclyVisible(row) && !row.moderationHidden) ? mapSnapshotNode(row) : null,
        ...(projection === 'member' || !isPubliclyVisible(row) ? {} : { tombstone: moderationTombstoneRef(row) }),
        annotation: null, relation: null,
      }));
    }
  }

  const annotationSteps: StreamStep[] = [];
  let annotationHasMore = false;
  if (includesAnnotations && !nodeHasMore && stream !== 'relations') {
    const emittedNodes = nodeSteps.filter((step) => step.node !== null).length;
    const remaining = Math.max(0, capacity - emittedNodes);
    const annotationRead = await loadAnnotationPage(ports.annotations, {
      collectionId: input.collectionId,
      projection,
      principal: input.principal,
      limit: Math.max(1, remaining),
      ...(stream === 'annotations' && afterLocator ? { afterLocator } : {}),
      ...(query.root ? { rootId: query.root } : {}),
      ...(query.depth !== undefined ? { depth: query.depth } : {}),
    });
    if (annotationRead.contentRevision !== collection.contentRevision
      || annotationRead.policyRevision !== collection.policyRevision
      || annotationRead.comparatorVersion !== PUBLICATION_ANNOTATION_COMPARATOR_VERSION) {
      throw new PublicationSnapshotExpiredError();
    }
    const consumed = Math.min(remaining, annotationRead.candidates.length);
    annotationHasMore = annotationRead.candidates.length > consumed;
    for (const row of annotationRead.candidates.slice(0, consumed)) {
      annotationSteps.push(Object.freeze({
        stream: 'annotations', locator: annotationLocatorOf(row), node: null, relation: null,
        annotation: isAnnotationVisible(row, projection, input.principal)
          ? mapPublicationAnnotation(row)
          : null,
      }));
    }
  }

  const relationSteps: StreamStep[] = [];
  let relationHasMore = false;
  if (includesRelations && !nodeHasMore && !annotationHasMore) {
    const emitted = nodeSteps.filter((step) => step.node !== null).length
      + annotationSteps.filter((step) => step.annotation !== null).length;
    const remaining = Math.max(0, capacity - emitted);
    const relationRead = await loadRelationPage(ports.relations, {
      collectionId: input.collectionId, projection, limit: Math.max(1, remaining),
      ...(stream === 'relations' && afterLocator ? { afterLocator } : {}),
      ...(query.root ? { rootId: query.root } : {}),
      ...(query.depth !== undefined ? { depth: query.depth } : {}),
    });
    if (relationRead.contentRevision !== collection.contentRevision
      || relationRead.policyRevision !== collection.policyRevision
      || relationRead.comparatorVersion !== PUBLICATION_RELATION_COMPARATOR_VERSION) {
      throw new PublicationSnapshotExpiredError();
    }
    const consumed = Math.min(remaining, relationRead.candidates.length);
    relationHasMore = relationRead.candidates.length > consumed;
    for (const row of relationRead.candidates.slice(0, consumed)) {
      relationSteps.push(Object.freeze({
        stream: 'relations', locator: relationLocatorOf(row), node: null, annotation: null,
        relation: isRelationVisible(
          row, collection.visibility, projection, projectionSelection.allowPrivateRelations,
        )
          ? mapPublicationRelation(row) : null,
      }));
    }
  }

  const steps = Object.freeze([...nodeSteps, ...annotationSteps, ...relationSteps]);
  const assemble = (stepCount: number): { snapshot: Snapshot; nextCursor: string | null; byteLength: number; moderationHiddenBookmarks: ModerationHiddenBookmarkRef[] } => {
    const consumed = steps.slice(0, stepCount);
    const point = nextContinuationPoint({
      consumed, nodeStepCount: nodeSteps.length, totalStepCount: steps.length,
      annotationStepCount: annotationSteps.length, nodeHasMore, annotationHasMore, relationHasMore,
    });
    const nextCursor = point === null ? null : ports.cursors.snapshot.sign({
      revision, comparatorVersion, ...cursorContextBase,
      nextPosition: encodeContinuation({
        expiresAt: cursorExpiresAt, sequence: sequence + 1, stream: point.stream,
        ...(point.afterLocator ? { afterLocator: point.afterLocator } : {}),
      }),
    });
    const moderationHiddenBookmarks = consumed.flatMap((step) => step.tombstone ? [step.tombstone] : []);
    const candidate = buildSnapshot({
      collection,
      attachments,
      nodes: [
        ...rootNodes,
        ...consumed.flatMap((step) => step.node === null ? [] : [step.node]),
      ],
      annotations: consumed.flatMap((step) =>
        step.annotation === null ? [] : [step.annotation]),
      relations: consumed.flatMap((step) => step.relation === null ? [] : [step.relation]),
      origin: ports.origin,
      revision,
      sequence,
      nextCursor,
      complete: querySelectsCompleteSnapshot(query),
      generatedAt: collection.updatedAt,
      logicalQuery: query,
    });
    const snapshot = projection === 'public'
      ? projectPublicationPublicWire(candidate, { publicExtensionNamespaces: PUBLIC_NODE_EXTENSIONS }) as unknown as Snapshot
      : candidate;
    return { snapshot, nextCursor, moderationHiddenBookmarks, byteLength: Buffer.byteLength(JSON.stringify(snapshot), 'utf8') };
  };

  let assembled = assemble(steps.length);
  if (assembled.byteLength > PUBLICATION_SNAPSHOT_MAX_BYTES && steps.length > 0) {
    // The first page may carry Root alone. A continuation must consume at least
    // one raw candidate so an oversized object cannot create an endless empty-page loop.
    let low = rootNodes.length > 0 ? 0 : 1;
    let high = steps.length - 1;
    let fitting: ReturnType<typeof assemble> | undefined;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const trial = assemble(midpoint);
      if (trial.byteLength <= PUBLICATION_SNAPSHOT_MAX_BYTES) {
        fitting = trial;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (fitting) assembled = fitting;
  }
  const { snapshot, nextCursor, moderationHiddenBookmarks, byteLength } = assembled;
  validatePage(snapshot);
  if (byteLength > PUBLICATION_SNAPSHOT_MAX_BYTES
    || snapshot.nodes.length + snapshot.annotations.length + snapshot.relations.length
      > PUBLICATION_SNAPSHOT_MAX_LIMIT) {
    throw new RangeError('Publication Snapshot page exceeds delivery limits');
  }
  return Object.freeze({
    snapshot,
    ownerSubjectId: collection.ownerSubjectId,
    projection,
    nextCursor,
    byteLength,
    ...(moderationHiddenBookmarks.length === 0 ? {} : { moderationHiddenBookmarks: Object.freeze(moderationHiddenBookmarks) }),
  });
}

interface NormalizedQuery {
  readonly root?: string;
  readonly depth?: number;
  readonly include: readonly ('annotations' | 'attachments' | 'relations')[];
  readonly limit: number;
  readonly pageCursor?: string;
}

export function normalizePublicationSnapshotQuery(value: PublicationSnapshotQueryInput['query']): NormalizedQuery {
  const query = value ?? {};
  const allowed = new Set(['root', 'depth', 'include', 'limit', 'pageCursor']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown Snapshot query field: ${key}`);
  }
  const limit = query.limit ?? PUBLICATION_SNAPSHOT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > PUBLICATION_SNAPSHOT_MAX_LIMIT) {
    throw new RangeError('Publication Snapshot limit must be between 2 and 500');
  }
  if (query.depth !== undefined
    && (!Number.isSafeInteger(query.depth) || query.depth < 0 || query.depth > 1_024)) {
    throw new RangeError('Publication Snapshot depth must be between 0 and 1024');
  }
  const include = Object.freeze([...new Set(query.include ?? [])].sort()) as NormalizedQuery['include'];
  if (include.some((item) => !['annotations', 'attachments', 'relations'].includes(item))) {
    throw new TypeError('Publication Snapshot include contains an unsupported value');
  }
  return Object.freeze({
    ...(query.root ? { root: query.root } : {}),
    ...(query.depth !== undefined ? { depth: query.depth } : {}),
    include,
    limit,
    ...(query.pageCursor ? { pageCursor: query.pageCursor } : {}),
  });
}

function querySelectsCompleteSnapshot(query: NormalizedQuery): boolean {
  if (query.root !== undefined || query.depth !== undefined) return false;
  if (query.include.length === 0) return true;
  return query.include.length === 3
    && ['annotations', 'attachments', 'relations'].every((name) =>
      query.include.includes(name as NormalizedQuery['include'][number]));
}

async function selectProjection(
  accessPolicy: AccessPolicyFactsPort,
  collection: PublicationCollectionRecord,
  principal: PublicationPrincipal,
  continuation: boolean,
): Promise<{ readonly projection: 'public' | 'member'; readonly allowPrivateRelations: boolean }> {
  const facts = await accessPolicy.loadCollectionFacts({
    collectionId: collection.id,
    actorSubjectId: principal.kind === 'account' ? principal.subjectId : 'anonymous',
  });
  if (facts === null || facts.deleted) {
    if (continuation) throw new PublicationSnapshotExpiredError();
    throw new PublicationNotFoundError();
  }
  if (facts.policyRevision !== collection.policyRevision || facts.visibility !== collection.visibility) {
    if (continuation) throw new PublicationSnapshotExpiredError();
    throw new PublicationNotFoundError();
  }
  if (principal.kind === 'account'
    && (facts.ownerSubjectId === principal.subjectId || facts.membershipRole !== null)) {
    return Object.freeze({
      projection: 'member' as const,
      allowPrivateRelations: facts.ownerSubjectId === principal.subjectId
        || facts.membershipRole === 'owner' || facts.membershipRole === 'editor',
    });
  }
  if (collection.visibility === 'public' || collection.visibility === 'unlisted') {
    return Object.freeze({ projection: 'public' as const, allowPrivateRelations: false });
  }
  throw new PublicationNotFoundError();
}

function requireReadableCollection(
  collection: PublicationCollectionRecord | null,
  root: PublicationNodeRecord | null,
  continuation: boolean,
): PublicationCollectionRecord {
  if (collection === null || root === null || collection.deletedAt !== null || collection.publicationSlug === null) {
    if (continuation) throw new PublicationSnapshotExpiredError();
    throw new PublicationNotFoundError();
  }
  return collection;
}

function publicationRevision(collection: PublicationCollectionRecord): string {
  return `${collection.contentRevision}.${collection.policyRevision}`;
}

function principalScope(principal: PublicationPrincipal): string {
  return principal.kind === 'anonymous' ? 'anonymous' : `account:${principal.principalId}`;
}

function comparatorScope(
  nodeComparator: string,
  includesAnnotations: boolean,
  includesRelations: boolean,
): string {
  return [nodeComparator,
    ...(includesAnnotations ? [PUBLICATION_ANNOTATION_COMPARATOR_VERSION] : []),
    ...(includesRelations ? [PUBLICATION_RELATION_COMPARATOR_VERSION] : []),
  ].join('+');
}

/** P4A-R06: closed ineligible-only exposure union; never project attachments. */
function projectEligibleSnapshotAttachments(
  verdicts: readonly SharedExposureEligibility[],
): readonly Attachment[] {
  const attachments: Attachment[] = [];
  for (const verdict of verdicts) {
    assertSharedExposureIneligible(verdict);
  }
  return Object.freeze(attachments);
}

function nodeLocatorOf(node: PublicationNodeRecord): string {
  if (node.parentId === null || node.position === null) {
    throw new Error('Publication continuation cannot target Root');
  }
  return locator(node.id);
}

function annotationLocatorOf(annotation: PublicationAnnotationRecord): string {
  return locator(annotation.id);
}

function relationLocatorOf(relation: PublicationRelationRecord): string {
  return locator(relation.id);
}

function locator(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
}

interface Continuation {
  readonly expiresAt: number;
  readonly sequence: number;
  readonly stream: 'nodes' | 'annotations' | 'relations';
  readonly afterLocator?: string;
}

function encodeContinuation(value: Continuation): string {
  return [
    '2',
    value.expiresAt.toString(36),
    value.sequence.toString(36),
    value.stream === 'nodes' ? 'n' : value.stream === 'annotations' ? 'a' : 'r',
    value.afterLocator ?? '-',
  ].join('~');
}

function decodeContinuation(value: string): Continuation {
  const parts = value.split('~');
  // N-1 Node-only cursors remain readable through their original three-part state.
  if (parts.length === 3) {
    return decodeContinuationParts(parts[0]!, parts[1]!, 'n', parts[2]!);
  }
  if (parts.length === 4) return decodeContinuationParts(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
  if (parts.length !== 5 || parts[0] !== '2') throw new PublicationSnapshotExpiredError();
  return decodeContinuationParts(parts[1]!, parts[2]!, parts[3]!, parts[4]!);
}

function decodeContinuationParts(
  expiresPart: string,
  sequencePart: string,
  streamPart: string,
  locatorPart: string,
): Continuation {
  const expiresAt = Number.parseInt(expiresPart, 36);
  const sequence = Number.parseInt(sequencePart, 36);
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(sequence) || sequence < 2
    || (streamPart !== 'n' && streamPart !== 'a' && streamPart !== 'r')) {
    throw new PublicationSnapshotExpiredError();
  }
  const afterLocator = locatorPart === '-' ? undefined : locatorPart;
  if (afterLocator !== undefined && !/^[0-9a-f]{32}$/u.test(afterLocator)) {
    throw new PublicationSnapshotExpiredError();
  }
  return {
    expiresAt, sequence,
    stream: streamPart === 'n' ? 'nodes' : streamPart === 'a' ? 'annotations' : 'relations',
    ...(afterLocator ? { afterLocator } : {}),
  };
}

function nextContinuationPoint(input: {
  readonly consumed: readonly StreamStep[];
  readonly nodeStepCount: number;
  readonly annotationStepCount: number;
  readonly totalStepCount: number;
  readonly nodeHasMore: boolean;
  readonly annotationHasMore: boolean;
  readonly relationHasMore: boolean;
}): ContinuationPoint | null {
  const consumedNodeCount = Math.min(input.consumed.length, input.nodeStepCount);
  if (consumedNodeCount < input.nodeStepCount) {
    const last = input.consumed.at(-1);
    return { stream: 'nodes', ...(last ? { afterLocator: last.locator } : {}) };
  }
  if (input.nodeHasMore) {
    const lastNode = input.consumed.slice(0, input.nodeStepCount).at(-1);
    return { stream: 'nodes', ...(lastNode ? { afterLocator: lastNode.locator } : {}) };
  }
  const consumedAnnotationCount = Math.max(0, input.consumed.length - input.nodeStepCount);
  const selectedAnnotationCount = input.annotationStepCount;
  if (consumedAnnotationCount < selectedAnnotationCount || input.annotationHasMore) {
    const lastAnnotation = input.consumed.slice(input.nodeStepCount).at(-1);
    return { stream: 'annotations', ...(lastAnnotation ? { afterLocator: lastAnnotation.locator } : {}) };
  }
  const relationStart = input.nodeStepCount + input.annotationStepCount;
  const consumedRelationCount = Math.max(0, input.consumed.length - relationStart);
  const selectedRelationCount = input.totalStepCount - relationStart;
  if (consumedRelationCount < selectedRelationCount || input.relationHasMore) {
    const lastRelation = input.consumed.slice(relationStart).at(-1);
    return { stream: 'relations', ...(lastRelation ? { afterLocator: lastRelation.locator } : {}) };
  }
  return null;
}

async function loadAnnotationPage(
  port: PublicationAnnotationReadPort | undefined,
  input: {
    readonly collectionId: string;
    readonly projection: 'public' | 'member';
    readonly principal: PublicationPrincipal;
    readonly limit: number;
    readonly afterLocator?: string;
    readonly rootId?: string;
    readonly depth?: number;
  },
): Promise<PublicationAnnotationReadPage> {
  if (!port) throw new Error('Publication Annotation projection is not configured');
  try {
    return await port.loadPage({
      collectionId: input.collectionId,
      projection: input.projection,
      ...(input.projection === 'member' && input.principal.kind === 'account'
        ? { principalId: input.principal.principalId }
        : {}),
      limit: input.limit,
      ...(input.afterLocator ? { afterLocator: input.afterLocator } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
    });
  } catch (error) {
    if (error instanceof PublicationSnapshotAnchorNotFoundError) {
      throw new PublicationSnapshotExpiredError();
    }
    throw error;
  }
}

async function loadRelationPage(
  port: PublicationRelationReadPort | undefined,
  input: {
    readonly collectionId: string;
    readonly projection: 'public' | 'member';
    readonly limit: number;
    readonly afterLocator?: string;
    readonly rootId?: string;
    readonly depth?: number;
  },
): Promise<PublicationRelationReadPage> {
  if (!port) throw new Error('Publication Relation projection is not configured');
  try {
    return await port.loadPage({
      collectionId: input.collectionId, projection: input.projection, limit: input.limit,
      ...(input.afterLocator ? { afterLocator: input.afterLocator } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
    });
  } catch (error) {
    if (error instanceof PublicationSnapshotAnchorNotFoundError) {
      throw new PublicationSnapshotExpiredError();
    }
    throw error;
  }
}

function isAnnotationVisible(
  row: PublicationAnnotationRecord,
  projection: 'public' | 'member',
  principal: PublicationPrincipal,
): boolean {
  if (row.deletedAt !== null || row.payload.id !== row.id
    || row.payload.collectionId !== row.collectionId
    || row.payload.subject.type !== row.subjectType || row.payload.subject.id !== row.subjectId
    || row.payload.visibility !== row.visibility) return false;
  if (projection === 'public') {
    if (row.visibility !== 'public' && row.visibility !== 'unlisted') return false;
    return row.subjectType === 'collection'
      || (row.subjectVisibility === 'inherit' && !row.subjectAncestorRestricted);
  }
  if (row.visibility === 'private') {
    return principal.kind === 'account' && row.creatorPrincipalId === principal.principalId;
  }
  return true;
}

function mapPublicationAnnotation(row: PublicationAnnotationRecord): Annotation {
  const provenance = redactPublicationProvenance(row.payload.provenance);
  return Object.freeze({
    id: row.id,
    collectionId: row.collectionId,
    subject: Object.freeze({ type: row.subjectType, id: row.subjectId }),
    type: row.payload.type,
    ...(row.payload.format ? { format: row.payload.format } : {}),
    value: structuredClone(row.payload.value),
    visibility: row.visibility,
    creator: Object.freeze({
      id: row.creatorUri,
      name: row.creatorDisplayName,
    }),
    createdAt: row.payload.createdAt,
    updatedAt: row.payload.updatedAt,
    revision: row.payload.revision,
    ...(provenance ? { provenance } : {}),
  });
}

function redactPublicationProvenance(value: Annotation['provenance']): Annotation['provenance'] {
  if (!value) return undefined;
  return Object.freeze({
    kind: value.kind,
    ...(value.generatedAt ? { generatedAt: value.generatedAt } : {}),
    ...(value.editedByHuman !== undefined ? { editedByHuman: value.editedByHuman } : {}),
  });
}

function isRelationVisible(
  row: PublicationRelationRecord,
  collectionVisibility: PublicationCollectionRecord['visibility'],
  projection: 'public' | 'member',
  allowPrivate: boolean,
): boolean {
  if (row.deletedAt !== null || row.payload.id !== row.id
    || row.payload.collectionId !== row.collectionId
    || row.payload.fromNodeId !== row.fromNodeId || row.payload.toNodeId !== row.toNodeId
    || row.payload.visibility !== row.visibility || !row.fromAuthorized || !row.toAuthorized
    || relationVisibilityRank(row.visibility) < collectionVisibilityRank(collectionVisibility)
    || relationVisibilityRank(row.visibility) < endpointVisibilityRank(
      row.fromVisibility, row.fromAncestorVisibility,
    )
    || relationVisibilityRank(row.visibility) < endpointVisibilityRank(
      row.toVisibility, row.toAncestorVisibility,
    )) return false;
  if (projection === 'public') {
    return (row.visibility === 'public' || row.visibility === 'unlisted')
      && row.fromVisibility === 'inherit' && !row.fromAncestorRestricted
      && row.toVisibility === 'inherit' && !row.toAncestorRestricted;
  }
  return row.visibility !== 'private' || allowPrivate;
}

function relationVisibilityRank(visibility: Relation['visibility']): number {
  return visibility === 'private' ? 2 : visibility === 'protected' ? 1 : 0;
}

function collectionVisibilityRank(visibility: PublicationCollectionRecord['visibility']): number {
  return visibility === 'private' ? 2 : visibility === 'protected' ? 1 : 0;
}

function endpointVisibilityRank(
  visibility: PublicationNodeRecord['visibility'],
  ancestorVisibility: PublicationRelationRecord['fromAncestorVisibility'],
): number {
  if (visibility === 'private' || ancestorVisibility === 'private') return 2;
  return visibility === 'protected' || ancestorVisibility === 'protected' ? 1 : 0;
}

function mapPublicationRelation(row: PublicationRelationRecord): Relation {
  return Object.freeze({
    id: row.id, collectionId: row.collectionId, type: row.payload.type,
    fromNodeId: row.fromNodeId, toNodeId: row.toNodeId,
    ...(row.payload.label !== undefined ? { label: row.payload.label } : {}),
    visibility: row.visibility, createdAt: row.payload.createdAt, updatedAt: row.payload.updatedAt,
    revision: row.payload.revision,
    ...(row.payload.extensions !== undefined
      ? { extensions: Object.freeze(structuredClone(row.payload.extensions)) } : {}),
  });
}

function mapSnapshotNode(row: PublicationNodeRecord): SnapshotNode {
  const common = {
    id: row.id,
    collectionId: row.collectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.resourceRevision,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.tags.length === 0 ? {} : { tags: [...row.tags] }),
  };
  if (row.isRoot) {
    return { ...common, kind: 'root', parentId: null, position: null, folderRole: 'root', title: row.title };
  }
  if (row.parentId === null || row.position === null) {
    throw new Error('Publication node is missing ordering fields');
  }
  const publicationPosition = row.publicationPosition ?? row.position;
  const visibility = row.visibility === 'inherit' ? {} : { visibility: row.visibility };
  if (row.kind === 'folder') {
    return {
      ...common, ...visibility, kind: 'folder', parentId: row.parentId,
      position: publicationPosition, title: row.title,
    };
  }
  if (row.url === null) throw new Error('Publication Bookmark is missing its URL');
  return {
    ...common, ...visibility, kind: 'bookmark', parentId: row.parentId,
    position: publicationPosition, title: row.title, url: row.url, ...publicBookmarkExtensions(row.pinned),
  };
}

function buildSnapshot(input: {
  collection: PublicationCollectionRecord;
  nodes: readonly SnapshotNode[];
  annotations: readonly Annotation[];
  relations: readonly Relation[];
  attachments: readonly Attachment[];
  origin: string;
  revision: string;
  sequence: number;
  nextCursor: string | null;
  complete: boolean;
  generatedAt: string;
  logicalQuery: NormalizedQuery;
}): Snapshot {
  const queryDigest = createHash('sha256').update(JSON.stringify({
    root: input.logicalQuery.root ?? null,
    depth: input.logicalQuery.depth ?? null,
    include: input.logicalQuery.include,
  })).digest('base64url').slice(0, 12);
  return {
    protocolVersion: '0.1',
    snapshotId: `snapshot-${input.collection.id}-${queryDigest}-${input.revision}${input.collection.bookmarkHideDigest ? `-${input.collection.bookmarkHideDigest}` : ''}`,
    mode: 'publication',
    complete: input.complete,
    collection: {
      schemaVersion: '0.1',
      id: input.collection.id,
      canonicalUrl: `${input.origin}/c/${input.collection.publicationSlug}` as HttpUrl,
      slug: input.collection.publicationSlug!,
      kind: input.collection.kind,
      title: input.collection.title,
      ...(input.collection.summary === null ? {} : { summary: input.collection.summary }),
      rootNodeId: input.collection.rootNodeId,
      visibility: input.collection.visibility,
      createdAt: input.collection.createdAt,
      updatedAt: input.collection.updatedAt,
      revision: input.revision,
    },
    nodes: [...input.nodes],
    annotations: [...input.annotations],
    attachments: [...input.attachments],
    relations: [...input.relations],
    tombstones: [],
    revision: input.revision,
    generatedAt: input.generatedAt,
    page: { nextCursor: input.nextCursor, hasMore: input.nextCursor !== null, sequence: input.sequence },
    warnings: [],
  };
}

function validatePage(snapshot: Snapshot): void {
  const structural = validators.validate('snapshot', snapshot);
  if (!structural.valid) {
    throw new Error(`Publication Snapshot failed COLP Schema validation: ${JSON.stringify(structural.errors)}`);
  }
  assertPublicationSnapshotBookmarkUrls(snapshot);
  const semantic = validateSnapshotSemantics(snapshot, PUBLICATION_PRODUCER_SEMANTICS);
  if (!semantic.valid) {
    throw new Error(`Publication Snapshot failed COLP semantic validation: ${JSON.stringify(semantic.issues)}`);
  }
}
