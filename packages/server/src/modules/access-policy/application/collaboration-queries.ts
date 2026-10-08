import { isValidAvatarUrl } from '../../identity/index.js';
import { evaluateAccess } from '../domain/evaluate.js';
import { CollaborationError } from '../domain/errors.js';
import type { ActorPrincipal } from '../domain/types.js';
import type { AccessPolicyFactsPort } from './ports.js';
import type {
  CollaborationMemberListItem,
  CollaborationPendingInviteListItem,
  CollaborationQueryPort,
  CollectionMembersPage,
  MyCollaborationInvitesPage,
} from './ports.js';
import {
  COLLABORATION_LIST_CURSOR_TTL_MS,
  CollaborationListCursorError,
  PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION,
  PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE,
  PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION,
  PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE,
  type ProductCollaborationMembersCursorSignerPort,
  type ProductMyCollaborationInvitesCursorSignerPort,
} from './collaboration-list-cursor.js';

export const COLLECTION_TITLE_SNAPSHOT_MAX_GRAPHEMES = 512;
/** Hard SQL LIMIT for GET members; ≥ product member cap (100). */
export const COLLABORATION_MEMBERS_LIST_LIMIT = 100;
/** Hard SQL LIMIT for collection pending invites; ≥ product pending cap (50). */
export const COLLABORATION_PENDING_INVITES_LIST_LIMIT = 50;
/** Hard SQL LIMIT for GET /me/collaboration-invites; ≥ invitee pending cap (50). */
export const COLLABORATION_MY_INVITES_LIST_LIMIT = 100;

export function truncateCollectionTitleSnapshot(title: string): string {
  if (typeof title !== 'string' || title.length === 0) return '';
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  let count = 0;
  let result = '';
  for (const { segment } of segmenter.segment(title)) {
    if (count >= COLLECTION_TITLE_SNAPSHOT_MAX_GRAPHEMES) break;
    result += segment;
    count += 1;
  }
  return result;
}

/** Server-computed 1–2 letters from displayName. Never derived from email. */
export function initialsFromDisplayName(displayName: string): string {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmed.length === 0) return '??';
  const words = trimmed.split(/\s+/u).filter((part) => part.length > 0);
  const graphemesOf = (value: string): string[] =>
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)].map((item) => item.segment);
  if (words.length === 1) {
    return graphemesOf(words[0]!).slice(0, 2).join('').toLocaleUpperCase('en-US');
  }
  const first = graphemesOf(words[0]!)[0] ?? '';
  const second = graphemesOf(words[1]!)[0] ?? '';
  const initials = `${first}${second}`.toLocaleUpperCase('en-US');
  return initials.length === 0 ? '??' : initials;
}

export interface ListCollectionMembersInput {
  readonly actor: ActorPrincipal;
  readonly collectionId: string;
  readonly now: Date;
  readonly cursor?: string;
}

export interface ListMyCollaborationInvitesInput {
  readonly actor: { readonly subjectId: string; readonly email: string };
  readonly now: Date;
  readonly cursor?: string;
}

export async function listCollectionMembers(
  ports: {
    readonly facts: AccessPolicyFactsPort;
    readonly query: CollaborationQueryPort;
    readonly cursors: ProductCollaborationMembersCursorSignerPort;
  },
  input: ListCollectionMembersInput,
): Promise<CollectionMembersPage> {
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const header = await ports.query.loadCollection(collectionId);
  if (!header || header.deletedAt !== null) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  const decision = evaluateAccess({
    collectionId: header.id,
    ownerSubjectId: header.ownerSubjectId,
    visibility: header.visibility,
    policyRevision: header.policyRevision,
    membershipRole: (await ports.facts.loadCollectionFacts({
      collectionId, actorSubjectId: input.actor.subjectId,
    }))?.membershipRole ?? null,
    deleted: false,
  }, { principalId: input.actor.principalId, subjectId: input.actor.subjectId, kind: 'account' }, 'read_editor');
  if (decision.outcome === 'conceal') {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  if (decision.outcome === 'deny') {
    throw new CollaborationError('insufficient_role', 'Caller cannot list members.');
  }
  const role = decision.effectiveRole;
  if (role === null) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  const canManage = role === 'owner';
  const canLeave = role === 'editor' || role === 'viewer';
  let membersAfter: { grantedAt: string; subjectId: string } | null = null;
  let invitesAfter: { createdAt: string; inviteId: string } | null = null;
  let membersExhausted = false;
  let invitesExhausted = false;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, input.now);
    if (cursor.purpose !== PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE
      || cursor.subjectId !== input.actor.subjectId
      || cursor.collectionId !== collectionId
      || cursor.comparatorVersion !== PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION) {
      throw new CollaborationListCursorError();
    }
    membersAfter = cursor.membersAfter;
    invitesAfter = cursor.invitesAfter;
    membersExhausted = cursor.membersExhausted;
    invitesExhausted = cursor.invitesExhausted;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  } else {
    issuedAt = input.now.toISOString();
    expiresAt = new Date(input.now.getTime() + COLLABORATION_LIST_CURSOR_TTL_MS).toISOString();
  }
  const memberRows = membersExhausted ? [] : await ports.query.listMembers({
    collectionId,
    limit: COLLABORATION_MEMBERS_LIST_LIMIT,
    ...(membersAfter
      ? { after: { grantedAt: new Date(membersAfter.grantedAt), subjectId: membersAfter.subjectId } }
      : {}),
  });
  const membersPage = takePage(memberRows, COLLABORATION_MEMBERS_LIST_LIMIT);
  let inviteItems: CollaborationPendingInviteListItem[] = [];
  let invitesHasMore = false;
  if (canManage && !invitesExhausted) {
    const inviteRows = await ports.query.listPendingInvites({
      collectionId,
      now: input.now,
      limit: COLLABORATION_PENDING_INVITES_LIST_LIMIT,
      ...(invitesAfter
        ? { after: { createdAt: new Date(invitesAfter.createdAt), inviteId: invitesAfter.inviteId } }
        : {}),
    });
    const taken = takePage(inviteRows, COLLABORATION_PENDING_INVITES_LIST_LIMIT);
    inviteItems = [...taken.items];
    invitesHasMore = taken.hasMore;
  }
  const hasMore = membersPage.hasMore || (canManage && invitesHasMore);
  const lastMember = membersPage.items.at(-1);
  const lastInvite = inviteItems.at(-1);
  const nextMembersExhausted = !membersPage.hasMore;
  const nextInvitesExhausted = !canManage || !invitesHasMore;
  const nextCursor = hasMore ? ports.cursors.sign({
    v: 1,
    purpose: PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE,
    subjectId: input.actor.subjectId,
    collectionId,
    comparatorVersion: PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION,
    membersAfter: nextMembersExhausted ? null : lastMember
      ? { grantedAt: lastMember.grantedAt.toISOString(), subjectId: lastMember.subjectId }
      : membersAfter,
    invitesAfter: nextInvitesExhausted ? null : lastInvite
      ? { createdAt: lastInvite.createdAt.toISOString(), inviteId: lastInvite.inviteId }
      : invitesAfter,
    membersExhausted: nextMembersExhausted,
    invitesExhausted: nextInvitesExhausted,
    issuedAt,
    expiresAt,
  }) : null;
  return {
    collection: { id: header.id, title: header.title },
    caller: {
      subjectId: input.actor.subjectId,
      role,
      canManage,
      canLeave,
    },
    policyEtag: strongPolicyEtag(header.policyRevision),
    members: membersPage.items.map((row) => toMemberItem(row, input.actor.subjectId, canManage)),
    invites: inviteItems.map(toInviteItem),
    page: {
      returnedCount: membersPage.items.length + inviteItems.length,
      hasMore,
      nextCursor,
    },
  };
}

export async function listMyCollaborationInvites(
  ports: {
    readonly query: CollaborationQueryPort;
    readonly cursors: ProductMyCollaborationInvitesCursorSignerPort;
  },
  input: ListMyCollaborationInvitesInput,
): Promise<MyCollaborationInvitesPage> {
  const email = input.actor.email.trim().toLowerCase();
  let after: { createdAt: string; inviteId: string } | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, input.now);
    if (cursor.purpose !== PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE
      || cursor.subjectId !== input.actor.subjectId
      || cursor.comparatorVersion !== PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION) {
      throw new CollaborationListCursorError();
    }
    after = cursor.after;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  } else {
    issuedAt = input.now.toISOString();
    expiresAt = new Date(input.now.getTime() + COLLABORATION_LIST_CURSOR_TTL_MS).toISOString();
  }
  const rows = await ports.query.listMyPendingInvites({
    subjectId: input.actor.subjectId,
    email,
    now: input.now,
    limit: COLLABORATION_MY_INVITES_LIST_LIMIT,
    ...(after ? { after: { createdAt: new Date(after.createdAt), inviteId: after.inviteId } } : {}),
  });
  const taken = takePage(rows, COLLABORATION_MY_INVITES_LIST_LIMIT);
  const last = taken.items.at(-1);
  const nextCursor = taken.hasMore && last ? ports.cursors.sign({
    v: 1,
    purpose: PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE,
    subjectId: input.actor.subjectId,
    comparatorVersion: PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION,
    after: { createdAt: last.invitedAt.toISOString(), inviteId: last.inviteId },
    issuedAt,
    expiresAt,
  }) : null;
  return {
    items: taken.items.map((row) => ({
      inviteId: row.inviteId,
      collectionId: row.collectionId,
      collectionTitle: row.collectionTitle,
      role: row.role,
      email: row.email,
      expiresAt: row.expiresAt.toISOString(),
      invitedAt: row.invitedAt.toISOString(),
    })),
    page: {
      returnedCount: taken.items.length,
      hasMore: taken.hasMore,
      nextCursor,
    },
  };
}

function takePage<T>(rows: readonly T[], limit: number): { items: readonly T[]; hasMore: boolean } {
  if (rows.length > limit + 1) {
    throw new Error('collaboration list query exceeded limit+1 contract');
  }
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

function toMemberItem(
  row: CollaborationMemberListItem,
  callerSubjectId: string,
  canManage: boolean,
): CollectionMembersPage['members'][number] {
  const emailVisible = canManage || row.subjectId === callerSubjectId;
  return {
    subjectId: row.subjectId,
    role: row.role,
    displayName: row.displayName,
    email: emailVisible ? row.email : null,
    initials: initialsFromDisplayName(row.displayName),
    avatarUrl: memberAvatarUrl(row.avatarUrl),
    grantedAt: row.grantedAt.toISOString(),
  };
}

function memberAvatarUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return isValidAvatarUrl(value) ? value : null;
}

function toInviteItem(
  row: CollaborationPendingInviteListItem,
): CollectionMembersPage['invites'][number] {
  return {
    inviteId: row.inviteId,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function strongPolicyEtag(policyRevision: string): string {
  return `"${policyRevision}"`;
}

function assertNonEmpty(value: string, _field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  return value;
}
