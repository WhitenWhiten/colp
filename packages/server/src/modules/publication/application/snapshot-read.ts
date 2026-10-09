import type { Annotation, Relation } from '@know-n/colp/types';

export const PUBLICATION_SNAPSHOT_COMPARATOR_VERSION = 'parent-position-id-v1' as const;
export const PUBLICATION_ANNOTATION_COMPARATOR_VERSION = 'subject-type-subject-id-id-v1' as const;
export const PUBLICATION_RELATION_COMPARATOR_VERSION = 'from-to-type-id-v1' as const;

export interface PublicationSnapshotPosition {
  readonly parentId: string;
  readonly position: string;
  readonly nodeId: string;
}

export interface PublicationSnapshotReadRequest {
  readonly collectionId: string;
  readonly limit: number;
  readonly after?: PublicationSnapshotPosition;
  /** Fixed-size digest locator resolved to the complete comparator tuple in the read transaction. */
  readonly afterLocator?: string;
  readonly rootId?: string;
  readonly depth?: number;
  /** Public reads must filter restricted rows before applying pagination. */
  readonly projection?: 'public' | 'member';
  /** Loads Collection/Root fence facts without scanning the Node stream. */
  readonly metadataOnly?: boolean;
  readonly signal?: AbortSignal;
}

export class PublicationSnapshotAnchorNotFoundError extends Error {
  constructor() {
    super('Publication Snapshot continuation anchor was not found.');
    this.name = 'PublicationSnapshotAnchorNotFoundError';
  }
}

export interface PublicationCollectionRecord {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly rootNodeId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly bookmarkHideDigest?: string;
}

export interface PublicationNodeRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark';
  readonly isRoot: boolean;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: 'inherit' | 'protected' | 'private';
  readonly ancestorRestricted: boolean;
  /**
   * This bookmark is under an active official hide_public action. Privacy
   * ancestry lives in ancestorRestricted; the two are kept apart so the
   * product page can publish an inert tombstone while every other consumer
   * (COLP snapshot, search, relations, annotations) keeps its own gate.
   */
  readonly moderationHidden: boolean;
  /** The owner pinned this bookmark above the folder's other bookmarks. */
  readonly pinned?: boolean;
  readonly position: string | null;
  /** COLP-safe sibling ordinal projected by PostgreSQL; internal positions may exceed the wire contract. */
  readonly publicationPosition?: string | null;
  readonly resourceRevision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Identity and ordering facts for a moderation-hidden bookmark; never body content. */
export interface ModerationHiddenBookmarkRef {
  readonly id: string;
  readonly parentId: string | null;
  readonly position: string | null;
}

/** Privacy ancestry (or Root) decides whether a node is publicly visible at all. */
export function isPubliclyVisible(node: PublicationNodeRecord): boolean {
  return node.isRoot || (!node.ancestorRestricted && node.visibility === 'inherit');
}

/** Bare locator for a hide_public tombstone, or null when the row needs none. */
export function moderationTombstoneRef(row: PublicationNodeRecord): ModerationHiddenBookmarkRef | null {
  if (!row.moderationHidden || row.kind !== 'bookmark') return null;
  return Object.freeze({ id: row.id, parentId: row.parentId, position: row.publicationPosition ?? row.position });
}

export interface PublicationSnapshotReadPage {
  readonly isolation: 'repeatable read';
  readonly comparatorVersion: typeof PUBLICATION_SNAPSHOT_COMPARATOR_VERSION;
  readonly collection: PublicationCollectionRecord | null;
  readonly root: PublicationNodeRecord | null;
  /** Untrimmed candidates: at most request.limit + 1 non-root live rows. */
  readonly candidates: readonly PublicationNodeRecord[];
}

export interface PublicationSnapshotReadPort {
  loadPage(request: PublicationSnapshotReadRequest): Promise<PublicationSnapshotReadPage>;
}

export interface PublicationAnnotationPosition {
  readonly subjectType: 'collection' | 'node';
  readonly subjectId: string;
  readonly annotationId: string;
}

export interface PublicationAnnotationReadRequest {
  readonly collectionId: string;
  readonly projection: 'public' | 'member';
  readonly principalId?: string;
  readonly limit: number;
  readonly after?: PublicationAnnotationPosition;
  readonly afterLocator?: string;
  readonly rootId?: string;
  readonly depth?: number;
}

export interface PublicationAnnotationRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly subjectType: 'collection' | 'node';
  readonly subjectId: string;
  /** Trusted authorization fact; never copied to the Publication DTO. */
  readonly creatorPrincipalId: string;
  readonly creatorUri: string;
  readonly creatorDisplayName: string;
  readonly visibility: Annotation['visibility'];
  readonly subjectVisibility: PublicationCollectionRecord['visibility'] | PublicationNodeRecord['visibility'];
  readonly subjectAncestorRestricted: boolean;
  readonly payload: Readonly<Annotation>;
  readonly deletedAt: Date | null;
}

export interface PublicationAnnotationReadPage {
  readonly isolation: 'repeatable read';
  readonly comparatorVersion: typeof PUBLICATION_ANNOTATION_COMPARATOR_VERSION;
  readonly contentRevision: string | null;
  readonly policyRevision: string | null;
  /** Authorization-filtered, untrimmed candidates: at most request.limit + 1. */
  readonly candidates: readonly PublicationAnnotationRecord[];
}

export interface PublicationAnnotationReadPort {
  loadPage(request: PublicationAnnotationReadRequest): Promise<PublicationAnnotationReadPage>;
}

export interface PublicationRelationPosition {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly type: Relation['type'];
  readonly relationId: string;
}

export interface PublicationRelationReadRequest {
  readonly collectionId: string;
  readonly projection: 'public' | 'member';
  readonly limit: number;
  readonly after?: PublicationRelationPosition;
  readonly afterLocator?: string;
  readonly rootId?: string;
  readonly depth?: number;
}

export interface PublicationRelationRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly visibility: Relation['visibility'];
  readonly fromVisibility: PublicationNodeRecord['visibility'];
  readonly toVisibility: PublicationNodeRecord['visibility'];
  readonly fromAuthorized: boolean;
  readonly toAuthorized: boolean;
  readonly fromAncestorVisibility: 'protected' | 'private' | null;
  readonly toAncestorVisibility: 'protected' | 'private' | null;
  readonly fromAncestorRestricted: boolean;
  readonly toAncestorRestricted: boolean;
  readonly payload: Readonly<Relation>;
  readonly deletedAt: Date | null;
}

export interface PublicationRelationReadPage {
  readonly isolation: 'repeatable read';
  readonly comparatorVersion: typeof PUBLICATION_RELATION_COMPARATOR_VERSION;
  readonly contentRevision: string | null;
  readonly policyRevision: string | null;
  readonly candidates: readonly PublicationRelationRecord[];
}

export interface PublicationRelationReadPort {
  loadPage(request: PublicationRelationReadRequest): Promise<PublicationRelationReadPage>;
}
