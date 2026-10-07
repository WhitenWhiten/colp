import { formatUtcDateTime, strongEntityTag } from '../domain/index.js';
import { isClassifyInboxEligible } from './classify-inbox-eligibility.js';
import {
  PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION,
  PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE,
  PRODUCT_CLASSIFY_INBOX_CURSOR_TTL_MS,
  PRODUCT_CLASSIFY_INBOX_SORT,
  ClassifyInboxCursorError,
  type ClassifyInboxCursorAfter,
  type ProductClassifyInboxCursorSignerPort,
} from './classify-inbox-cursor.js';
import {
  scoreClassifyInboxSuggestions,
  type ClassifyInboxSuggestion,
} from './classify-inbox-score.js';
import { hostnameFromBookmarkUrl } from './link-health-url.js';
import type { CollectionsClock } from './ports.js';

export const CLASSIFY_INBOX_DEFAULT_LIMIT = 20;
export const CLASSIFY_INBOX_MAX_LIMIT = 50;

export class ClassifyInboxInputError extends Error {
  readonly code = 'invalid_query' as const;
  constructor(message: string) { super(message); this.name = 'ClassifyInboxInputError'; }
}

export interface ClassifyInboxBookmarkRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly url: string;
  readonly resourceRevision: string;
  readonly createdAt: Date;
  readonly isOwner: boolean;
  readonly kind: 'root' | 'folder' | 'bookmark';
  readonly softDeleted: boolean;
  readonly parentKind: 'root' | 'folder' | 'bookmark';
  readonly hasSidecar: boolean;
}

export interface ClassifyInboxFolderRow {
  readonly collectionId: string;
  readonly folderId: string;
  readonly folderTitle: string;
}

export interface ClassifyInboxReadInput {
  readonly ownerSubjectId: string;
  readonly limit: number;
  readonly after?: { readonly createdAt: Date; readonly nodeId: string };
}

export interface ClassifyInboxReadPort {
  listInboxBookmarks(input: ClassifyInboxReadInput): Promise<readonly ClassifyInboxBookmarkRow[]>;
  listLiveFolders(input: {
    readonly ownerSubjectId: string;
    readonly collectionIds: readonly string[];
  }): Promise<readonly ClassifyInboxFolderRow[]>;
}

export interface GetMyClassifyInboxPageInput {
  readonly actor: { readonly subjectId: string };
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ClassifyInboxItem {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly etag: string;
  readonly createdAt: string;
  readonly suggestions: readonly ClassifyInboxSuggestion[];
}

export interface ClassifyInboxPage {
  readonly items: readonly ClassifyInboxItem[];
  readonly nextCursor: string | null;
}

export interface GetMyClassifyInboxPagePorts {
  readonly reads: ClassifyInboxReadPort;
  readonly cursors: ProductClassifyInboxCursorSignerPort;
  readonly clock: CollectionsClock;
}

export async function getMyClassifyInboxPage(
  ports: GetMyClassifyInboxPagePorts,
  input: GetMyClassifyInboxPageInput,
): Promise<ClassifyInboxPage> {
  const subjectId = nonEmpty(input.actor?.subjectId, 'actor.subjectId');
  if (input.cursor !== undefined && input.limit !== undefined) {
    throw new ClassifyInboxInputError('cursor and first-page parameters are mutually exclusive');
  }
  const now = await ports.clock.now();
  let limit: number;
  let after: ClassifyInboxCursorAfter | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, now);
    if (cursor.subjectId !== subjectId || cursor.purpose !== PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE
      || cursor.sort !== PRODUCT_CLASSIFY_INBOX_SORT
      || cursor.comparatorVersion !== PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION) {
      throw new ClassifyInboxCursorError();
    }
    limit = cursor.limit;
    after = cursor.after;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  } else {
    limit = normalizeLimit(input.limit);
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + PRODUCT_CLASSIFY_INBOX_CURSOR_TTL_MS));
  }
  const rows = await ports.reads.listInboxBookmarks({
    ownerSubjectId: subjectId,
    limit,
    ...(after ? {
      after: { createdAt: new Date(after.createdAt), nodeId: after.nodeId },
    } : {}),
  });
  if (rows.length > limit + 1) throw new Error('classify-inbox read port exceeded limit+1 contract');
  const pageRows = rows.slice(0, limit).filter((row) => isClassifyInboxEligible({
    isOwner: row.isOwner,
    kind: row.kind,
    softDeleted: row.softDeleted,
    url: row.url,
    parentKind: row.parentKind,
    hasSidecar: row.hasSidecar,
  }));
  const collectionIds = [...new Set(pageRows.map((row) => row.collectionId))];
  const folders = collectionIds.length === 0
    ? []
    : await ports.reads.listLiveFolders({ ownerSubjectId: subjectId, collectionIds });
  const foldersByCollection = new Map<string, ClassifyInboxFolderRow[]>();
  for (const candidate of folders) {
    const members = foldersByCollection.get(candidate.collectionId);
    if (members) members.push(candidate);
    else foldersByCollection.set(candidate.collectionId, [candidate]);
  }
  const items = pageRows.map((row) => toItem(row, foldersByCollection.get(row.collectionId) ?? []));
  const hasMore = rows.length > limit;
  const last = rows.slice(0, limit).at(-1);
  const nextCursor = hasMore && last ? ports.cursors.sign({
    v: 1, purpose: PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE, subjectId, limit,
    sort: PRODUCT_CLASSIFY_INBOX_SORT, comparatorVersion: PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION,
    after: {
      createdAt: last.createdAt.toISOString(),
      nodeId: last.nodeId,
    },
    issuedAt, expiresAt,
  }) : null;
  return { items, nextCursor };
}

function toItem(
  row: ClassifyInboxBookmarkRow,
  candidateFolders: readonly ClassifyInboxFolderRow[],
): ClassifyInboxItem {
  const title = row.title.length > 0 ? row.title : row.url;
  return {
    nodeId: row.nodeId,
    collectionId: row.collectionId,
    collectionTitle: row.collectionTitle,
    title,
    url: row.url,
    host: hostnameFromBookmarkUrl(row.url) ?? 'invalid',
    etag: strongEntityTag(row.resourceRevision),
    createdAt: formatUtcDateTime(row.createdAt),
    suggestions: scoreClassifyInboxSuggestions({
      bookmark: { title, url: row.url },
      candidateFolders: candidateFolders.map((folder) => ({
        folderId: folder.folderId,
        folderTitle: folder.folderTitle,
      })),
    }),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return CLASSIFY_INBOX_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > CLASSIFY_INBOX_MAX_LIMIT) {
    throw new ClassifyInboxInputError(`limit must be an integer between 1 and ${CLASSIFY_INBOX_MAX_LIMIT}`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClassifyInboxInputError(`${field} is required`);
  }
  return value;
}
