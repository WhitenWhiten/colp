import { formatUtcDateTime, strongEntityTag } from '../domain/index.js';
import {
  PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
  PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
  PRODUCT_LINK_HEALTH_CURSOR_TTL_MS,
  PRODUCT_LINK_HEALTH_SORT,
  LinkHealthCursorError,
  type LinkHealthCursorAfter,
  type LinkHealthCursorFilters,
  type LinkHealthCursorStatus,
  type LinkHealthScope,
  type ProductLinkHealthCursorSignerPort,
} from './link-health-cursor.js';
import type { LinkHealthErrorClass } from './link-health-probe-status.js';
import { hostnameFromBookmarkUrl, normalizeBookmarkUrl } from './link-health-url.js';
import type { CollectionsClock } from './ports.js';

export const LINK_HEALTH_DEFAULT_LIMIT = 50;
export const LINK_HEALTH_MAX_LIMIT = 100;

export type LinkHealthStatus = LinkHealthCursorStatus;
export type { LinkHealthErrorClass, LinkHealthScope };
export type LinkHealthMembership = 'owner' | 'editor' | 'viewer';

export class LinkHealthInputError extends Error {
  readonly code = 'invalid_query' as const;
  constructor(message: string) { super(message); this.name = 'LinkHealthInputError'; }
}

export interface LinkHealthBookmarkUrlFact {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly url: string;
  readonly createdAt: Date;
}

export interface LinkHealthRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly url: string;
  readonly resourceRevision: string;
  readonly createdAt: Date;
  readonly status: LinkHealthStatus;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly checkedAt: Date | null;
  readonly membership: LinkHealthMembership;
  readonly errorClass: LinkHealthErrorClass | null;
  readonly duplicateRelationId: string | null;
  readonly duplicateRelationRevision: string | null;
}

export interface LinkHealthReadInput {
  readonly ownerSubjectId: string;
  readonly limit: number;
  readonly status?: LinkHealthStatus;
  readonly collectionId?: string;
  readonly nodeIds?: readonly string[];
  readonly after?: { readonly checkedAt: Date | null; readonly nodeId: string };
  /** Omitted means owned (N-1 default). */
  readonly scope?: LinkHealthScope;
}

export interface LinkHealthReadPort {
  listOwnedBookmarkUrlFacts(input: {
    readonly ownerSubjectId: string;
    readonly collectionId?: string;
    readonly scope?: LinkHealthScope;
  }): Promise<readonly LinkHealthBookmarkUrlFact[]>;
  listLinkHealth(input: LinkHealthReadInput): Promise<readonly LinkHealthRow[]>;
}

export interface GetMyLinkHealthPageInput {
  readonly actor: { readonly subjectId: string };
  readonly status?: LinkHealthStatus;
  readonly collectionId?: string;
  readonly duplicate?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly scope?: LinkHealthScope;
}

export interface LinkHealthItem {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly url: string;
  readonly status: LinkHealthStatus;
  readonly duplicateOfNodeId: string | null;
  readonly host?: string;
  readonly httpStatus?: number;
  readonly finalUrl?: string;
  readonly checkedAt?: string;
  readonly etag?: string;
  readonly membership?: LinkHealthMembership;
  readonly errorClass?: LinkHealthErrorClass;
  readonly duplicateRelationId?: string;
  readonly duplicateRelationEtag?: string;
}

export interface LinkHealthPage {
  readonly items: readonly LinkHealthItem[];
  readonly nextCursor: string | null;
}

export interface GetMyLinkHealthPagePorts {
  readonly reads: LinkHealthReadPort;
  readonly cursors: ProductLinkHealthCursorSignerPort;
  readonly clock: CollectionsClock;
}

export function duplicateOfNodeIdByNormalizedUrl(
  facts: readonly LinkHealthBookmarkUrlFact[],
): ReadonlyMap<string, string | null> {
  const groups = new Map<string, LinkHealthBookmarkUrlFact[]>();
  const result = new Map<string, string | null>();
  for (const fact of facts) {
    result.set(fact.nodeId, null);
    const normalized = normalizeBookmarkUrl(fact.url);
    if (normalized === null) continue;
    const key = `${fact.collectionId}\0${normalized}`;
    const members = groups.get(key);
    if (members) members.push(fact);
    else groups.set(key, [fact]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const earliest = earliestNodeId(members);
    for (const member of members) {
      if (member.nodeId !== earliest) result.set(member.nodeId, earliest);
    }
  }
  return result;
}

export async function getMyLinkHealthPage(
  ports: GetMyLinkHealthPagePorts,
  input: GetMyLinkHealthPageInput,
): Promise<LinkHealthPage> {
  const subjectId = nonEmpty(input.actor?.subjectId, 'actor.subjectId');
  if (input.cursor !== undefined && (input.limit !== undefined || input.status !== undefined
    || input.collectionId !== undefined || input.duplicate !== undefined
    || input.scope !== undefined)) {
    throw new LinkHealthInputError('cursor and first-page parameters are mutually exclusive');
  }
  const now = await ports.clock.now();
  let limit: number;
  let filters: LinkHealthCursorFilters;
  let after: LinkHealthCursorAfter | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, now);
    if (cursor.subjectId !== subjectId || cursor.purpose !== PRODUCT_LINK_HEALTH_CURSOR_PURPOSE
      || cursor.sort !== PRODUCT_LINK_HEALTH_SORT
      || cursor.comparatorVersion !== PRODUCT_LINK_HEALTH_COMPARATOR_VERSION) {
      throw new LinkHealthCursorError();
    }
    if (cursor.filters.scope === undefined && input.scope !== undefined && input.scope !== 'owned') {
      throw new LinkHealthCursorError();
    }
    limit = cursor.limit;
    filters = {
      status: cursor.filters.status,
      collectionId: cursor.filters.collectionId,
      duplicate: cursor.filters.duplicate,
      scope: cursor.filters.scope ?? 'owned',
    };
    after = cursor.after;
    issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  } else {
    limit = normalizeLimit(input.limit);
    if (input.status !== undefined && !isStatus(input.status)) {
      throw new LinkHealthInputError('status is invalid');
    }
    if (input.scope !== undefined && !isScope(input.scope)) {
      throw new LinkHealthInputError('scope is invalid');
    }
    if (input.collectionId !== undefined) nonEmpty(input.collectionId, 'collectionId');
    filters = {
      status: input.status ?? null,
      collectionId: input.collectionId ?? null,
      duplicate: input.duplicate === true,
      scope: input.scope ?? 'owned',
    };
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + PRODUCT_LINK_HEALTH_CURSOR_TTL_MS));
  }
  const scope = filters.scope ?? 'owned';
  const facts = await ports.reads.listOwnedBookmarkUrlFacts({
    ownerSubjectId: subjectId,
    scope,
    ...(filters.collectionId ? { collectionId: filters.collectionId } : {}),
  });
  const duplicateOf = duplicateOfNodeIdByNormalizedUrl(facts);
  let nodeIds: readonly string[] | undefined;
  if (filters.duplicate) {
    nodeIds = facts.filter((fact) => duplicateOf.get(fact.nodeId) != null).map((fact) => fact.nodeId);
    if (nodeIds.length === 0) return { items: [], nextCursor: null };
  }
  const rows = await ports.reads.listLinkHealth({
    ownerSubjectId: subjectId,
    limit,
    scope,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.collectionId ? { collectionId: filters.collectionId } : {}),
    ...(nodeIds ? { nodeIds } : {}),
    ...(after ? {
      after: {
        checkedAt: after.checkedAt === null ? null : new Date(after.checkedAt),
        nodeId: after.nodeId,
      },
    } : {}),
  });
  if (rows.length > limit + 1) throw new Error('link-health read port exceeded limit+1 contract');
  const items = rows.slice(0, limit).map((row) => toItem(row, duplicateOf.get(row.nodeId) ?? null));
  const hasMore = rows.length > limit;
  const last = rows.slice(0, limit).at(-1);
  const nextCursor = hasMore && last ? ports.cursors.sign({
    v: 1, purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE, subjectId, filters, limit,
    sort: PRODUCT_LINK_HEALTH_SORT, comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: {
      checkedAt: last.checkedAt === null ? null : last.checkedAt.toISOString(),
      nodeId: last.nodeId,
    },
    issuedAt, expiresAt,
  }) : null;
  return { items, nextCursor };
}

function toItem(row: LinkHealthRow, duplicateOfNodeId: string | null): LinkHealthItem {
  const host = hostnameFromBookmarkUrl(row.url);
  return {
    nodeId: row.nodeId,
    collectionId: row.collectionId,
    collectionTitle: row.collectionTitle,
    title: row.title.length > 0 ? row.title : row.url,
    url: row.url,
    status: row.status,
    duplicateOfNodeId,
    ...(host ? { host } : {}),
    ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
    ...(row.finalUrl ? { finalUrl: row.finalUrl } : {}),
    ...(row.checkedAt ? { checkedAt: formatUtcDateTime(row.checkedAt) } : {}),
    etag: strongEntityTag(row.resourceRevision),
    membership: row.membership,
    ...(row.errorClass ? { errorClass: row.errorClass } : {}),
    ...(row.duplicateRelationId && row.duplicateRelationRevision ? {
      duplicateRelationId: row.duplicateRelationId,
      duplicateRelationEtag: strongEntityTag(row.duplicateRelationRevision),
    } : {}),
  };
}

function earliestNodeId(members: readonly LinkHealthBookmarkUrlFact[]): string {
  return [...members].sort((left, right) => {
    const time = left.createdAt.getTime() - right.createdAt.getTime();
    if (time !== 0) return time;
    if (left.nodeId < right.nodeId) return -1;
    if (left.nodeId > right.nodeId) return 1;
    return 0;
  })[0]!.nodeId;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return LINK_HEALTH_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > LINK_HEALTH_MAX_LIMIT) {
    throw new LinkHealthInputError(`limit must be an integer between 1 and ${LINK_HEALTH_MAX_LIMIT}`);
  }
  return value;
}

function isStatus(value: string): value is LinkHealthStatus {
  return value === 'pending' || value === 'healthy' || value === 'redirect' || value === 'broken';
}

function isScope(value: string): value is LinkHealthScope {
  return value === 'owned' || value === 'shared' || value === 'all';
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LinkHealthInputError(`${field} is required`);
  }
  return value;
}
