import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE = 'product-collection-members-cursor' as const;
export const PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE = 'product-my-collaboration-invites-cursor' as const;
export const PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION =
  'members-granted-at-asc-subject-id+invites-created-at-asc-id-v1' as const;
export const PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION = 'created-at-asc-id-v1' as const;
export const COLLABORATION_LIST_CURSOR_TTL_MS = 15 * 60 * 1000;

export class CollaborationListCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() {
    super('invalid cursor');
    this.name = 'CollaborationListCursorError';
  }
}

export interface CollaborationMembersCursorAfter {
  readonly grantedAt: string;
  readonly subjectId: string;
}
export interface CollaborationInvitesCursorAfter {
  readonly createdAt: string;
  readonly inviteId: string;
}
export interface CollaborationMembersCursorPayload {
  readonly v: 1;
  readonly purpose: typeof PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE;
  readonly subjectId: string;
  readonly collectionId: string;
  readonly comparatorVersion: typeof PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly membersAfter: CollaborationMembersCursorAfter | null;
  readonly invitesAfter: CollaborationInvitesCursorAfter | null;
  readonly membersExhausted: boolean;
  readonly invitesExhausted: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type CollaborationMembersCursorUnsignedPayload = Omit<CollaborationMembersCursorPayload, 'keyVersion'>;
export interface MyCollaborationInvitesCursorPayload {
  readonly v: 1;
  readonly purpose: typeof PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE;
  readonly subjectId: string;
  readonly comparatorVersion: typeof PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: CollaborationInvitesCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type MyCollaborationInvitesCursorUnsignedPayload = Omit<MyCollaborationInvitesCursorPayload, 'keyVersion'>;

export interface CollaborationListCursorKey {
  readonly id: string;
  readonly key: string;
}
export interface CollaborationListCursorPreviousKey extends CollaborationListCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ProductCollaborationMembersCursorSignerPort {
  sign(payload: CollaborationMembersCursorUnsignedPayload): string;
  verify(token: string, now: Date): CollaborationMembersCursorPayload;
  destroy(): void;
}
export interface ProductMyCollaborationInvitesCursorSignerPort {
  sign(payload: MyCollaborationInvitesCursorUnsignedPayload): string;
  verify(token: string, now: Date): MyCollaborationInvitesCursorPayload;
  destroy(): void;
}

const membersPayloadKeys = [
  'collectionId', 'comparatorVersion', 'expiresAt', 'invitesAfter', 'invitesExhausted',
  'issuedAt', 'keyVersion', 'membersAfter', 'membersExhausted', 'purpose', 'subjectId', 'v',
];
const myInvitesPayloadKeys = [
  'after', 'comparatorVersion', 'expiresAt', 'issuedAt', 'keyVersion', 'purpose', 'subjectId', 'v',
];
const memberAfterKeys = ['grantedAt', 'subjectId'];
const inviteAfterKeys = ['createdAt', 'inviteId'];

export function createProductCollaborationMembersCursorSigner(keys: {
  readonly current: CollaborationListCursorKey;
  readonly previous?: readonly CollaborationListCursorPreviousKey[];
}): ProductCollaborationMembersCursorSignerPort {
  return createSigner(keys, validateMembers);
}

export function createProductMyCollaborationInvitesCursorSigner(keys: {
  readonly current: CollaborationListCursorKey;
  readonly previous?: readonly CollaborationListCursorPreviousKey[];
}): ProductMyCollaborationInvitesCursorSignerPort {
  return createSigner(keys, validateMyInvites);
}

function createSigner<TPayload extends { readonly keyVersion: string; readonly issuedAt: string; readonly expiresAt: string }>(
  keys: {
    readonly current: CollaborationListCursorKey;
    readonly previous?: readonly CollaborationListCursorPreviousKey[];
  },
  validate: (value: unknown) => TPayload,
): {
  sign(payload: Omit<TPayload, 'keyVersion'>): string;
  verify(token: string, now: Date): TPayload;
  destroy(): void;
} {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: COLLABORATION_LIST_CURSOR_TTL_MS,
    keys,
    invalid: () => new CollaborationListCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid collaboration list cursor key',
      tooManyKeys: 'collaboration list cursor supports at most 8 previous keys',
      uniqueKeys: 'collaboration list cursor keys must be unique',
      retention: 'collaboration list previous key retention must cover cursor TTL',
    },
  });
}

function validateMembers(value: unknown): CollaborationMembersCursorPayload {
  if (!recordWithExactKeys(value, membersPayloadKeys)) throw new Error();
  if (value.v !== 1 || value.purpose !== PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE
    || value.comparatorVersion !== PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1
    || typeof value.collectionId !== 'string' || value.collectionId.length < 1
    || typeof value.keyVersion !== 'string'
    || typeof value.membersExhausted !== 'boolean' || typeof value.invitesExhausted !== 'boolean'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  const membersAfter = parseMemberAfter(value.membersAfter);
  const invitesAfter = parseInviteAfter(value.invitesAfter);
  parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose: PRODUCT_COLLECTION_MEMBERS_CURSOR_PURPOSE,
    subjectId: value.subjectId, collectionId: value.collectionId,
    comparatorVersion: PRODUCT_COLLECTION_MEMBERS_CURSOR_COMPARATOR_VERSION,
    keyVersion: value.keyVersion, membersAfter, invitesAfter,
    membersExhausted: value.membersExhausted, invitesExhausted: value.invitesExhausted,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}

function validateMyInvites(value: unknown): MyCollaborationInvitesCursorPayload {
  if (!recordWithExactKeys(value, myInvitesPayloadKeys)) throw new Error();
  if (value.v !== 1 || value.purpose !== PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE
    || value.comparatorVersion !== PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1
    || typeof value.keyVersion !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  if (!recordWithExactKeys(value.after, inviteAfterKeys)
    || typeof value.after.createdAt !== 'string' || value.after.createdAt.length < 1
    || typeof value.after.inviteId !== 'string' || value.after.inviteId.length < 1) throw new Error();
  parseCursorTimestamp(value.after.createdAt); parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose: PRODUCT_MY_COLLABORATION_INVITES_CURSOR_PURPOSE,
    subjectId: value.subjectId,
    comparatorVersion: PRODUCT_MY_COLLABORATION_INVITES_CURSOR_COMPARATOR_VERSION,
    keyVersion: value.keyVersion,
    after: { createdAt: value.after.createdAt, inviteId: value.after.inviteId },
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}

function parseMemberAfter(value: unknown): CollaborationMembersCursorAfter | null {
  if (value === null) return null;
  if (!recordWithExactKeys(value, memberAfterKeys)
    || typeof value.grantedAt !== 'string' || value.grantedAt.length < 1
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1) throw new Error();
  parseCursorTimestamp(value.grantedAt);
  return { grantedAt: value.grantedAt, subjectId: value.subjectId };
}

function parseInviteAfter(value: unknown): CollaborationInvitesCursorAfter | null {
  if (value === null) return null;
  if (!recordWithExactKeys(value, inviteAfterKeys)
    || typeof value.createdAt !== 'string' || value.createdAt.length < 1
    || typeof value.inviteId !== 'string' || value.inviteId.length < 1) throw new Error();
  parseCursorTimestamp(value.createdAt);
  return { createdAt: value.createdAt, inviteId: value.inviteId };
}
