import type { CollectionVisibility, MembershipRole, ResourcePolicyFacts } from '../domain/types.js';
import type { VerifiedAccountEmailPort } from '../../identity/index.js';
import type { ProductCommandReceiptPort } from '../../commands/index.js';

/**
 * Transaction-bound facts loader for collections use cases.
 * Implementations live in infrastructure and must not leak Kysely/pg types here.
 * Callers pass the same UoW transaction used for collection row lock / mutation.
 */
export interface AccessPolicyFactsPort {
  /**
   * Load authoritative policy facts for an actor within the caller's transaction.
   * Returns null when the collection row is absent.
   * Soft-deleted collections still return facts with deleted=true (evaluator conceals).
   * Does not write any tables.
   */
  loadCollectionFacts(input: {
    readonly collectionId: string;
    readonly actorSubjectId: string;
  }): Promise<ResourcePolicyFacts | null>;
}

/**
 * Membership / policy write port for owned-collection bootstrap (P1-04) and
 * future member/policy commands.
 *
 * Hard boundary: only `collection_members` and `collection_policies`.
 * Must not write collections, nodes, revisions, or other content tables.
 */
export interface AccessPolicyWritePort {
  insertMembership(input: {
    readonly collectionId: string;
    readonly subjectId: string;
    readonly role: MembershipRole;
    readonly grantedAt: Date;
  }): Promise<void>;

  /**
   * Deletes membership for (collectionId, subjectId).
   * Returns true when a row was removed.
   * Does not revoke owner_subject ownership on collections.
   */
  deleteMembership(input: {
    readonly collectionId: string;
    readonly subjectId: string;
  }): Promise<boolean>;

  /**
   * Inserts or updates the collection_policies row for bootstrap/policy management.
   * policyJson defaults to empty object when omitted.
   * Does not advance collections.policy_revision (caller owns revision effects).
   */
  upsertCollectionPolicy(input: {
    readonly collectionId: string;
    readonly policyJson?: Readonly<Record<string, unknown>>;
    readonly updatedAt: Date;
  }): Promise<void>;
}

/** Combined ports bound to one database transaction. */
export interface AccessPolicyPorts {
  readonly facts: AccessPolicyFactsPort;
  readonly writes: AccessPolicyWritePort;
}

export type CollaboratorGrantRole = 'editor' | 'viewer';

export type CollaborationInviteStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'revoked'
  | 'expired';

export interface CollaborationLockedCollection {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly visibility: CollectionVisibility;
  readonly policyRevision: string;
  readonly contentRevision: string;
  readonly title: string;
  readonly deletedAt: Date | null;
}

/**
 * Collections port: lock the collection row FOR UPDATE, then bump policy_revision
 * (new token + policy_revisions row) without changing content_revision,
 * commit_ordinal, or writing operations. The Postgres adapter also advances
 * authz_cache_version and, when publication_slug and published_at are both
 * present, appends a publication.cache_purge.requested v2 outbox row in the
 * same transaction. Private unpublished collections (null publication_slug)
 * skip purge honestly.
 * Must be used inside the same transaction as the membership/invite mutation.
 */
export interface CollectionPolicyRevisionPort {
  lockForUpdate(collectionId: string): Promise<CollaborationLockedCollection | null>;
  bumpPolicyRevision(collectionId: string): Promise<string>;
}

export interface CollaborationMembershipRecord {
  readonly collectionId: string;
  readonly subjectId: string;
  readonly role: MembershipRole;
  readonly grantedAt: Date;
}

export interface CollaborationInviteRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly role: CollaboratorGrantRole;
  readonly emailNormalized: string;
  readonly invitedSubjectId: string | null;
  readonly invitedBySubjectId: string;
  readonly status: CollaborationInviteStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly acceptedSubjectId: string | null;
  readonly collectionTitleSnapshot: string;
}

export interface CollaborationCollectionHeader {
  readonly id: string;
  readonly title: string;
  readonly ownerSubjectId: string;
  readonly visibility: CollectionVisibility;
  readonly policyRevision: string;
  readonly deletedAt: Date | null;
}

export interface CollaborationMemberListItem {
  readonly subjectId: string;
  readonly role: MembershipRole;
  readonly displayName: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly grantedAt: Date;
}

export interface CollaborationPendingInviteListItem {
  readonly inviteId: string;
  readonly email: string;
  readonly role: CollaboratorGrantRole;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface MyCollaborationInviteListItem {
  readonly inviteId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly role: CollaboratorGrantRole;
  readonly email: string;
  readonly expiresAt: Date;
  readonly invitedAt: Date;
}

export interface CollaborationListPageState {
  readonly returnedCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface CollectionMembersPage {
  readonly collection: { readonly id: string; readonly title: string };
  readonly caller: {
    readonly subjectId: string;
    readonly role: 'owner' | 'editor' | 'viewer';
    readonly canManage: boolean;
    readonly canLeave: boolean;
  };
  readonly policyEtag: string;
  readonly members: readonly {
    readonly subjectId: string;
    readonly role: MembershipRole;
    readonly displayName: string;
    readonly email: string | null;
    readonly initials: string;
    readonly avatarUrl: string | null;
    readonly grantedAt: string;
  }[];
  readonly invites: readonly {
    readonly inviteId: string;
    readonly email: string;
    readonly role: CollaboratorGrantRole;
    readonly createdAt: string;
    readonly expiresAt: string;
  }[];
  readonly page: CollaborationListPageState;
}

export interface MyCollaborationInvitesPage {
  readonly items: readonly {
    readonly inviteId: string;
    readonly collectionId: string;
    readonly collectionTitle: string;
    readonly role: CollaboratorGrantRole;
    readonly email: string | null;
    readonly expiresAt: string;
    readonly invitedAt: string;
  }[];
  readonly page: CollaborationListPageState;
}

export interface CollaborationMemberListQuery {
  readonly collectionId: string;
  readonly after?: { readonly grantedAt: Date; readonly subjectId: string };
  readonly limit: number;
}

export interface CollaborationPendingInviteListQuery {
  readonly collectionId: string;
  readonly now: Date;
  readonly after?: { readonly createdAt: Date; readonly inviteId: string };
  readonly limit: number;
}

export interface CollaborationMyPendingInviteListQuery {
  readonly subjectId: string;
  readonly email: string;
  readonly now: Date;
  readonly after?: { readonly createdAt: Date; readonly inviteId: string };
  readonly limit: number;
}

export interface CollaborationQueryPort {
  loadCollection(collectionId: string): Promise<CollaborationCollectionHeader | null>;
  /** Returns at most `limit + 1` rows so the application can detect hasMore. */
  listMembers(input: CollaborationMemberListQuery): Promise<readonly CollaborationMemberListItem[]>;
  listPendingInvites(input: CollaborationPendingInviteListQuery): Promise<readonly CollaborationPendingInviteListItem[]>;
  listMyPendingInvites(input: CollaborationMyPendingInviteListQuery): Promise<readonly MyCollaborationInviteListItem[]>;
}

export interface CollaborationInviteEmailPort {
  readonly enabled: boolean;
  insertDeliveryIfAbsent(input: {
    readonly deliveryId: string;
    readonly inviteId: string;
    readonly now: Date;
  }): Promise<'inserted' | 'exists'>;
  suppressIfUnsent(inviteId: string, now: Date): Promise<boolean>;
}

export interface CollaborationInviteOutboxPort {
  appendInviteCreated(input: {
    readonly inviteId: string;
    readonly collectionId: string;
    readonly now: Date;
  }): Promise<void>;
}

export interface CollaborationStorePort {
  expireOverdueInvites(collectionId: string, now: Date): Promise<number>;
  countMembersAndPending(collectionId: string): Promise<number>;
  countPendingInvites(collectionId: string): Promise<number>;
  countPendingInvitesForInvitee(input: {
    readonly emailNormalized: string;
    readonly invitedSubjectId: string | null;
  }): Promise<number>;
  findMembership(collectionId: string, subjectId: string): Promise<CollaborationMembershipRecord | null>;
  findPendingByEmail(collectionId: string, emailNormalized: string): Promise<CollaborationInviteRecord | null>;
  findInviteById(inviteId: string): Promise<CollaborationInviteRecord | null>;
  /**
   * System purge for P9 email change: pending unbound rows for this mailbox
   * only. Bound invites stay subject-bound and are not touched.
   */
  revokePendingUnboundInvitesByEmail(emailNormalized: string, now: Date): Promise<number>;
  insertInvite(row: CollaborationInviteRecord): Promise<void>;
  updateInvite(inviteId: string, patch: Partial<CollaborationInviteRecord>): Promise<boolean>;
  insertMembership(row: CollaborationMembershipRecord): Promise<void>;
  updateMembershipRole(
    collectionId: string,
    subjectId: string,
    role: CollaboratorGrantRole,
  ): Promise<boolean>;
  deleteMembership(collectionId: string, subjectId: string): Promise<boolean>;
}

export interface CollaborationHttpPorts extends CollaborationCommandPorts {
  readonly query: CollaborationQueryPort;
}

export interface CollaborationUnitOfWork {
  execute<Result>(work: (ports: CollaborationHttpPorts) => Promise<Result>): Promise<Result>;
}

export interface CollaborationAuditEvent {
  readonly principalId: string;
  readonly eventType: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface CollaborationCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: { now(): Promise<Date> };
  readonly ids?: { nextInviteId(): string };
  readonly identity: VerifiedAccountEmailPort;
  readonly facts: AccessPolicyFactsPort;
  readonly collections: CollectionPolicyRevisionPort;
  readonly store: CollaborationStorePort;
  readonly audit: { append(event: CollaborationAuditEvent): Promise<void> };
  readonly inviteEmail: CollaborationInviteEmailPort;
  readonly inviteOutbox: CollaborationInviteOutboxPort;
}
