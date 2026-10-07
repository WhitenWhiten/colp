/**
 * Shared in-memory classify-inbox fixture for the CL-S1 scorer and CL-S2
 * eligibility suites. Builds a frozen owned-collection graph (root + live
 * bookmark + live folder + optional sidecar decision row). Tests assert
 * through `toEligibilitySnapshot` / `toScoreInput`, never by poking I/O.
 *
 * Plain objects only. No database, no HTTP. Sidecar existence is the
 * in-memory `hasSidecar` bit; table inserts belong to a later task.
 */
import type {
  ClassifyInboxEligibilitySnapshot,
  ClassifyInboxNodeKind,
} from '../../src/modules/collections/application/classify-inbox-eligibility.js';
import type { ClassifyInboxScoreInput } from '../../src/modules/collections/application/classify-inbox-score.js';

export type ClassifyInboxDecisionStatus = 'accepted' | 'skipped';

export interface ClassifyInboxCollectionSnapshot {
  readonly id: string;
  readonly title: string;
  readonly ownerSubjectId: string;
}

export interface ClassifyInboxNodeSnapshot {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: ClassifyInboxNodeKind;
  readonly title: string;
  readonly url: string | null;
  readonly softDeleted: boolean;
}

export interface ClassifyInboxSidecarSnapshot {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly accountSubjectId: string;
  readonly status: ClassifyInboxDecisionStatus;
  readonly suggestionId: string | null;
}

export interface ClassifyInboxFixture {
  readonly collection: ClassifyInboxCollectionSnapshot;
  readonly root: ClassifyInboxNodeSnapshot;
  readonly bookmark: ClassifyInboxNodeSnapshot;
  readonly folder: ClassifyInboxNodeSnapshot;
  readonly sidecar: ClassifyInboxSidecarSnapshot | null;
  readonly isOwner: boolean;
}

export interface ClassifyInboxFixtureOverrides {
  readonly collection?: Partial<ClassifyInboxCollectionSnapshot>;
  readonly root?: Partial<ClassifyInboxNodeSnapshot>;
  readonly bookmark?: Partial<ClassifyInboxNodeSnapshot>;
  readonly folder?: Partial<ClassifyInboxNodeSnapshot>;
  readonly sidecar?: Partial<ClassifyInboxSidecarSnapshot> | null;
  readonly isOwner?: boolean;
  readonly hasSidecar?: boolean;
}

const DEFAULT_COLLECTION_ID = 'col-classify-inbox';
const DEFAULT_ROOT_ID = 'node-root';
const DEFAULT_BOOKMARK_ID = 'node-bookmark';
const DEFAULT_FOLDER_ID = 'fld-spacing';
const DEFAULT_OWNER_SUBJECT_ID = 'subject-owner';
const DEFAULT_BOOKMARK_TITLE = 'Design systems';
const DEFAULT_BOOKMARK_URL = 'https://system.example.com/essay';
const DEFAULT_FOLDER_TITLE = 'Spacing as a system';

export function buildClassifyInboxFixture(
  overrides: ClassifyInboxFixtureOverrides = {},
): ClassifyInboxFixture {
  const collection = Object.freeze({
    id: DEFAULT_COLLECTION_ID,
    title: 'Inbox library',
    ownerSubjectId: DEFAULT_OWNER_SUBJECT_ID,
    ...overrides.collection,
  });
  const root = Object.freeze({
    id: DEFAULT_ROOT_ID,
    collectionId: collection.id,
    parentId: null,
    kind: 'root' as const,
    title: 'Root',
    url: null,
    softDeleted: false,
    ...overrides.root,
  });
  const folder = Object.freeze({
    id: DEFAULT_FOLDER_ID,
    collectionId: collection.id,
    parentId: root.id,
    kind: 'folder' as const,
    title: DEFAULT_FOLDER_TITLE,
    url: null,
    softDeleted: false,
    ...overrides.folder,
  });
  const bookmark = Object.freeze({
    id: DEFAULT_BOOKMARK_ID,
    collectionId: collection.id,
    parentId: root.id,
    kind: 'bookmark' as const,
    title: DEFAULT_BOOKMARK_TITLE,
    url: DEFAULT_BOOKMARK_URL,
    softDeleted: false,
    ...overrides.bookmark,
  });
  return Object.freeze({
    collection,
    root,
    bookmark,
    folder,
    sidecar: resolveSidecar(collection, bookmark, folder, overrides),
    isOwner: overrides.isOwner ?? true,
  });
}

export function toEligibilitySnapshot(
  fixture: ClassifyInboxFixture,
): ClassifyInboxEligibilitySnapshot {
  return Object.freeze({
    isOwner: fixture.isOwner,
    kind: fixture.bookmark.kind,
    softDeleted: fixture.bookmark.softDeleted,
    url: fixture.bookmark.url ?? '',
    parentKind: parentKindOfBookmark(fixture),
    hasSidecar: fixture.sidecar !== null,
  });
}

export function toScoreInput(fixture: ClassifyInboxFixture): ClassifyInboxScoreInput {
  return Object.freeze({
    bookmark: Object.freeze({
      title: fixture.bookmark.title,
      url: fixture.bookmark.url ?? '',
    }),
    candidateFolders: Object.freeze([
      Object.freeze({
        folderId: fixture.folder.id,
        folderTitle: fixture.folder.title,
      }),
    ]),
  });
}

function resolveSidecar(
  collection: ClassifyInboxCollectionSnapshot,
  bookmark: ClassifyInboxNodeSnapshot,
  folder: ClassifyInboxNodeSnapshot,
  overrides: ClassifyInboxFixtureOverrides,
): ClassifyInboxSidecarSnapshot | null {
  if (overrides.sidecar === null) {
    return null;
  }
  if (overrides.hasSidecar !== true && overrides.sidecar === undefined) {
    return null;
  }
  const status = overrides.sidecar?.status ?? 'skipped';
  return Object.freeze({
    nodeId: overrides.sidecar?.nodeId ?? bookmark.id,
    collectionId: overrides.sidecar?.collectionId ?? collection.id,
    accountSubjectId: overrides.sidecar?.accountSubjectId ?? collection.ownerSubjectId,
    status,
    suggestionId:
      overrides.sidecar?.suggestionId !== undefined
        ? overrides.sidecar.suggestionId
        : status === 'accepted'
          ? folder.id
          : null,
  });
}

function parentKindOfBookmark(fixture: ClassifyInboxFixture): ClassifyInboxNodeKind {
  if (fixture.bookmark.parentId === fixture.folder.id) {
    return fixture.folder.kind;
  }
  if (fixture.bookmark.parentId === fixture.root.id) {
    return fixture.root.kind;
  }
  return fixture.root.kind;
}
