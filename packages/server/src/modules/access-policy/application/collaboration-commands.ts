import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { generateOpaqueId, IdentityError, assertValidEmail } from '../../identity/index.js';
import { authorizeCapability } from './authorize.js';
import { truncateCollectionTitleSnapshot } from './collaboration-queries.js';
import type {
  CollaborationAuditEvent,
  CollaborationCommandPorts,
  CollaborationInviteRecord,
  CollaborationLockedCollection,
  CollaborationMembershipRecord,
  CollaborationStorePort,
  CollaboratorGrantRole,
} from './ports.js';
import { CollaborationError, CollaborationPreconditionError } from '../domain/errors.js';
import type { ActorPrincipal } from '../domain/types.js';

export const COLLABORATION_COMMAND_CONTRACT_VERSION = '1.0.0';
export const COLLABORATION_MEMBER_LIMIT = 100;
export const COLLABORATION_PENDING_INVITE_LIMIT = 50;
export const COLLABORATION_INVITEE_PENDING_LIMIT = 50;
export const COLLABORATION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_ALREADY_PENDING_MESSAGE = 'An invitation is already pending';
export const ALREADY_MEMBER_MESSAGE = 'This person already has access';

export function inviteMemberCommandScope(collectionId: string): string {
  return `collection:${collectionId}:members:invite`;
}
export function revokeInviteCommandScope(collectionId: string): string {
  return `collection:${collectionId}:members:invite:revoke`;
}
export function updateMemberRoleCommandScope(collectionId: string): string {
  return `collection:${collectionId}:members:role`;
}
export function removeMemberCommandScope(collectionId: string): string {
  return `collection:${collectionId}:members:remove`;
}
export function acceptInviteCommandScope(inviteId: string): string {
  return `collaboration-invite:${inviteId}:accept`;
}
export function declineInviteCommandScope(inviteId: string): string {
  return `collaboration-invite:${inviteId}:decline`;
}

/**
 * Invitee matching after P9 email change: a bound invite is subject-only;
 * an unknown-mailbox invite is product-email-only. Email must never steal
 * an invite already bound to another subject.
 */
export function inviteMatchesInvitee(
  invite: Pick<CollaborationInviteRecord, 'invitedSubjectId' | 'emailNormalized'>,
  actor: Pick<CollaborationActor, 'subjectId' | 'email'>,
): boolean {
  if (invite.invitedSubjectId !== null) {
    return invite.invitedSubjectId === actor.subjectId;
  }
  return actor.email.trim().toLowerCase() === invite.emailNormalized;
}

export interface CollaborationActor {
  readonly principalId: string;
  readonly subjectId: string;
  readonly kind: 'account';
  readonly email: string;
}

export interface CollaborationCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly commandScope?: string;
}

export interface InviteMemberInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly email: string;
  readonly role: string;
  readonly inviteId?: string;
  readonly ifMatch?: string;
}

export interface AcceptInviteInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly inviteId: string;
}

export interface DeclineInviteInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly inviteId: string;
}

export interface RevokeInviteInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly inviteId: string;
  readonly ifMatch?: string;
}

export interface UpdateMemberRoleInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly subjectId: string;
  readonly role: string;
  readonly ifMatch?: string;
}

export interface RemoveMemberInput {
  readonly actor: CollaborationActor;
  readonly command: CollaborationCommand;
  readonly collectionId: string;
  readonly subjectId: string;
  readonly ifMatch?: string;
}

export interface CollaborationInviteView {
  readonly inviteId: string;
  readonly collectionId: string;
  readonly role: CollaboratorGrantRole;
  readonly email: string;
  readonly status: 'pending';
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CollaborationMembershipView {
  readonly collectionId: string;
  readonly subjectId: string;
  readonly role: CollaboratorGrantRole;
  readonly grantedAt: string;
}

export type CollaborationCommandResult =
  | { readonly kind: 'invited'; readonly invite: CollaborationInviteView; readonly policyRevision: string }
  | { readonly kind: 'accepted'; readonly membership: CollaborationMembershipView; readonly policyRevision: string }
  | { readonly kind: 'updated'; readonly membership: CollaborationMembershipView; readonly policyRevision: string }
  | { readonly kind: 'removed'; readonly collectionId: string; readonly subjectId: string; readonly policyRevision: string }
  | { readonly kind: 'revoked'; readonly inviteId: string; readonly policyRevision: string }
  | { readonly kind: 'declined'; readonly inviteId: string; readonly policyRevision: string }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
      readonly contractVersion: string;
      readonly targetIdentity?: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export async function expireOverdueInvites(
  store: CollaborationCommandPorts['store'],
  collectionId: string,
  now: Date,
): Promise<number> {
  return store.expireOverdueInvites(collectionId, now);
}

/**
 * Internal/system purge: revoke pending unbound invites for a mailbox after
 * the product email leaves that address. Bound invites stay subject-bound.
 */
export async function purgePendingUnboundInvitesForEmail(
  store: Pick<CollaborationStorePort, 'revokePendingUnboundInvitesByEmail'>,
  email: string,
  now: Date,
): Promise<number> {
  if (typeof email !== 'string') return 0;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return 0;
  return store.revokePendingUnboundInvitesByEmail(normalized, now);
}

export async function inviteMember(
  ports: CollaborationCommandPorts,
  input: InviteMemberInput,
): Promise<CollaborationCommandResult> {
  const email = normalizeInviteEmail(input.email);
  const role = assertGrantRole(input.role);
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const command = assertCommand(input.command, inviteMemberCommandScope(collectionId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const locked = await admitMemberCommand(ports, actor, collectionId, input.ifMatch);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  assertNotSelfInvite(actor, email, locked.ownerSubjectId);

  const verified = await ports.identity.findVerifiedActiveAccountByEmail(email);
  if (verified && (verified.subjectId === actor.subjectId)) {
    throw new CollaborationError('self_invite', 'Cannot invite yourself.');
  }
  if (verified) {
    const existing = await ports.store.findMembership(collectionId, verified.subjectId);
    if (existing) {
      throw new CollaborationError('already_member', ALREADY_MEMBER_MESSAGE);
    }
  }

  const pending = await ports.store.findPendingByEmail(collectionId, email);
  if (pending) {
    throw new CollaborationError('invite_already_pending', INVITE_ALREADY_PENDING_MESSAGE);
  }

  const pendingOnCollection = await ports.store.countPendingInvites(collectionId);
  if (pendingOnCollection >= COLLABORATION_PENDING_INVITE_LIMIT) {
    throw new CollaborationError('pending_invite_limit', 'This collection has reached its pending invite limit.');
  }

  const occupied = await ports.store.countMembersAndPending(collectionId);
  if (occupied >= COLLABORATION_MEMBER_LIMIT) {
    throw new CollaborationError('member_limit', 'This collection has reached its member limit.');
  }

  const inviteePending = await ports.store.countPendingInvitesForInvitee({
    emailNormalized: email,
    invitedSubjectId: verified?.subjectId ?? null,
  });
  if (inviteePending >= COLLABORATION_INVITEE_PENDING_LIMIT) {
    throw new CollaborationError('pending_invite_limit', 'This person already has too many pending invitations.');
  }

  const inviteId = input.inviteId?.trim() || ports.ids?.nextInviteId() || generateOpaqueId();
  const createdAt = now;
  const expiresAt = new Date(now.getTime() + COLLABORATION_INVITE_TTL_MS);
  const record: CollaborationInviteRecord = {
    id: inviteId,
    collectionId,
    role,
    emailNormalized: email,
    invitedSubjectId: verified?.subjectId ?? null,
    invitedBySubjectId: actor.subjectId,
    status: 'pending',
    expiresAt,
    createdAt,
    resolvedAt: null,
    acceptedSubjectId: null,
    collectionTitleSnapshot: truncateCollectionTitleSnapshot(locked.title),
  };
  await ports.store.insertInvite(record);
  const deliveryId = generateOpaqueId();
  const deliveryInsert = await ports.inviteEmail.insertDeliveryIfAbsent({
    deliveryId, inviteId, now: createdAt,
  });
  if (deliveryInsert === 'inserted') {
    await ports.inviteOutbox.appendInviteCreated({ inviteId, collectionId, now: createdAt });
  }
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  const invite = toInviteView(record);
  await writeAudit(ports, actor, now, 'collection.invite_created', {
    collectionId, inviteId, role,
  });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 201,
    body: encodeJson(toInviteCreatedBody(invite, policyRevision)),
    headers: { location: `/api/v1/collections/${collectionId}/members/invites/${inviteId}` },
    targetIdentity: inviteId,
  });
  return { kind: 'invited', invite, policyRevision };
}

export async function revokeInvite(
  ports: CollaborationCommandPorts,
  input: RevokeInviteInput,
): Promise<CollaborationCommandResult> {
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const inviteId = assertNonEmpty(input.inviteId, 'inviteId');
  const command = assertCommand(input.command, revokeInviteCommandScope(collectionId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const locked = await admitMemberCommand(ports, actor, collectionId, input.ifMatch);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  const invite = await requireInviteOnCollection(ports, inviteId, collectionId);
  if (invite.status !== 'pending') {
    throw new CollaborationError('invite_not_pending', 'Invitation is not pending.');
  }
  await ports.store.updateInvite(inviteId, { status: 'revoked', resolvedAt: now });
  await ports.inviteEmail.suppressIfUnsent(inviteId, now);
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  await writeAudit(ports, actor, now, 'collection.invite_revoked', { collectionId, inviteId });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 204, body: new Uint8Array(), targetIdentity: inviteId,
  });
  return { kind: 'revoked', inviteId, policyRevision };
}

export async function acceptInvite(
  ports: CollaborationCommandPorts,
  input: AcceptInviteInput,
): Promise<CollaborationCommandResult> {
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const inviteId = assertNonEmpty(input.inviteId, 'inviteId');
  const command = assertCommand(input.command, acceptInviteCommandScope(inviteId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const locked = await lockLiveCollection(ports, collectionId);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  const invite = await ports.store.findInviteById(inviteId);
  if (!invite || invite.collectionId !== collectionId) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  assertInviteeActor(actor, invite);

  const existing = await ports.store.findMembership(collectionId, actor.subjectId);
  if (existing && existing.role !== 'owner') {
    const membership = toMembershipView(existing);
    await complete(ports.receipts, binding, command.fingerprint, {
      status: 200,
      body: encodeJson(toMembershipBody(membership, locked.policyRevision)),
      targetIdentity: actor.subjectId,
    });
    return { kind: 'accepted', membership, policyRevision: locked.policyRevision };
  }
  if (existing?.role === 'owner') {
    throw new CollaborationError('already_member', ALREADY_MEMBER_MESSAGE);
  }

  if (invite.status === 'expired' || invite.expiresAt.getTime() <= now.getTime()) {
    throw new CollaborationError('invite_expired', 'Invitation has expired.');
  }
  if (invite.status !== 'pending') {
    throw new CollaborationError('invite_not_pending', 'Invitation is not pending.');
  }

  const membershipRow: CollaborationMembershipRecord = {
    collectionId,
    subjectId: actor.subjectId,
    role: invite.role,
    grantedAt: now,
  };
  await ports.store.insertMembership(membershipRow);
  await ports.store.updateInvite(inviteId, {
    status: 'accepted',
    resolvedAt: now,
    acceptedSubjectId: actor.subjectId,
  });
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  const membership = toMembershipView(membershipRow);
  await writeAudit(ports, actor, now, 'collection.invite_accepted', {
    collectionId, inviteId, subjectId: actor.subjectId, role: invite.role,
  });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 200,
    body: encodeJson(toMembershipBody(membership, policyRevision)),
    targetIdentity: actor.subjectId,
  });
  return { kind: 'accepted', membership, policyRevision };
}

export async function declineInvite(
  ports: CollaborationCommandPorts,
  input: DeclineInviteInput,
): Promise<CollaborationCommandResult> {
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const inviteId = assertNonEmpty(input.inviteId, 'inviteId');
  const command = assertCommand(input.command, declineInviteCommandScope(inviteId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  await lockLiveCollection(ports, collectionId);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  const invite = await ports.store.findInviteById(inviteId);
  if (!invite || invite.collectionId !== collectionId) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  assertInviteeActor(actor, invite);
  if (invite.status === 'expired' || invite.expiresAt.getTime() <= now.getTime()) {
    throw new CollaborationError('invite_expired', 'Invitation has expired.');
  }
  if (invite.status !== 'pending') {
    throw new CollaborationError('invite_not_pending', 'Invitation is not pending.');
  }
  await ports.store.updateInvite(inviteId, { status: 'declined', resolvedAt: now });
  await ports.inviteEmail.suppressIfUnsent(inviteId, now);
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  await writeAudit(ports, actor, now, 'collection.invite_declined', { collectionId, inviteId });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 204, body: new Uint8Array(), targetIdentity: inviteId,
  });
  return { kind: 'declined', inviteId, policyRevision };
}

export async function updateMemberRole(
  ports: CollaborationCommandPorts,
  input: UpdateMemberRoleInput,
): Promise<CollaborationCommandResult> {
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const subjectId = assertNonEmpty(input.subjectId, 'subjectId');
  const role = assertGrantRole(input.role);
  const command = assertCommand(input.command, updateMemberRoleCommandScope(collectionId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const locked = await admitMemberCommand(ports, actor, collectionId, input.ifMatch);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  if (subjectId === locked.ownerSubjectId) {
    throw new CollaborationError('owner_immutable', 'Owner membership cannot be changed.');
  }
  const member = await ports.store.findMembership(collectionId, subjectId);
  if (!member) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  if (member.role === 'owner') {
    throw new CollaborationError('owner_immutable', 'Owner membership cannot be changed.');
  }
  await ports.store.updateMembershipRole(collectionId, subjectId, role);
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  const membership = toMembershipView({ ...member, role });
  await writeAudit(ports, actor, now, 'collection.member_role_updated', {
    collectionId, subjectId, role,
  });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 200,
    body: encodeJson(toMembershipBody(membership, policyRevision)),
    targetIdentity: subjectId,
  });
  return { kind: 'updated', membership, policyRevision };
}

export async function removeMember(
  ports: CollaborationCommandPorts,
  input: RemoveMemberInput,
): Promise<CollaborationCommandResult> {
  const actor = assertActor(input.actor);
  const collectionId = assertNonEmpty(input.collectionId, 'collectionId');
  const subjectId = assertNonEmpty(input.subjectId, 'subjectId');
  const command = assertCommand(input.command, removeMemberCommandScope(collectionId));
  const binding = toBinding(actor.principalId, command);
  const claim = await ports.receipts.claim(binding, command.fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const selfLeave = actor.subjectId === subjectId;
  const locked = await admitMemberCommand(ports, actor, collectionId, input.ifMatch, selfLeave);
  const now = await ports.clock.now();
  await expireOverdueInvites(ports.store, collectionId, now);
  if (subjectId === locked.ownerSubjectId) {
    throw new CollaborationError('owner_immutable', 'Owner membership cannot be removed.');
  }
  const member = await ports.store.findMembership(collectionId, subjectId);
  if (!member) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  if (member.role === 'owner') {
    throw new CollaborationError('owner_immutable', 'Owner membership cannot be removed.');
  }
  await ports.store.deleteMembership(collectionId, subjectId);
  const policyRevision = await ports.collections.bumpPolicyRevision(collectionId);
  await writeAudit(ports, actor, now, 'collection.member_removed', { collectionId, subjectId });
  await complete(ports.receipts, binding, command.fingerprint, {
    status: 204, body: new Uint8Array(), targetIdentity: subjectId,
  });
  return { kind: 'removed', collectionId, subjectId, policyRevision };
}

/** Version facts are only observable after command authorization, under the same lock. */
async function admitMemberCommand(
  ports: CollaborationCommandPorts,
  actor: CollaborationActor,
  collectionId: string,
  ifMatch: string | undefined,
  selfLeave = false,
): Promise<CollaborationLockedCollection> {
  const locked = await lockLiveCollection(ports, collectionId);
  if (selfLeave) {
    const membership = await ports.store.findMembership(collectionId, actor.subjectId);
    if (!membership) throw new CollaborationError('conceal', 'Resource was not found.');
  } else {
    await authorizeManageMembers(ports, actor, collectionId);
  }
  assertPolicyIfMatch(ifMatch, locked.policyRevision);
  return locked;
}

async function lockLiveCollection(
  ports: CollaborationCommandPorts,
  collectionId: string,
): Promise<CollaborationLockedCollection> {
  const locked = await ports.collections.lockForUpdate(collectionId);
  if (!locked || locked.deletedAt !== null) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  return locked;
}

function assertPolicyIfMatch(ifMatch: string | undefined, policyRevision: string): void {
  if (ifMatch === undefined) return;
  const current = `"${policyRevision}"`;
  if (ifMatch !== current) {
    throw new CollaborationPreconditionError(current);
  }
}

async function authorizeManageMembers(
  ports: CollaborationCommandPorts,
  actor: CollaborationActor,
  collectionId: string,
): Promise<void> {
  const decision = await authorizeCapability(ports.facts, {
    collectionId,
    actor: toPrincipal(actor),
    capability: 'manage_members',
  });
  if (decision.outcome === 'allow') return;
  if (decision.outcome === 'conceal') {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  throw new CollaborationError('insufficient_role', 'Caller cannot manage members.');
}

function assertInviteeActor(actor: CollaborationActor, invite: CollaborationInviteRecord): void {
  if (!inviteMatchesInvitee(invite, actor)) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
}

async function requireInviteOnCollection(
  ports: CollaborationCommandPorts,
  inviteId: string,
  collectionId: string,
): Promise<CollaborationInviteRecord> {
  const invite = await ports.store.findInviteById(inviteId);
  if (!invite || invite.collectionId !== collectionId) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  return invite;
}

function assertNotSelfInvite(
  actor: CollaborationActor,
  email: string,
  ownerSubjectId: string,
): void {
  if (email === actor.email.trim().toLowerCase()) {
    throw new CollaborationError('self_invite', 'Cannot invite yourself.');
  }
  if (actor.subjectId === ownerSubjectId && email === actor.email.trim().toLowerCase()) {
    throw new CollaborationError('self_invite', 'Cannot invite yourself.');
  }
}

function normalizeInviteEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new CollaborationError('invalid_email', 'email is not a valid address');
  }
  const normalized = email.trim().toLowerCase();
  try {
    const validated = assertValidEmail(normalized);
    if (validated === null || validated.length < 3 || validated.length > 254) {
      throw new CollaborationError('invalid_email', 'email is not a valid address');
    }
    return validated;
  } catch (error: unknown) {
    if (error instanceof CollaborationError) throw error;
    if (error instanceof IdentityError && error.code === 'invalid_email') {
      throw new CollaborationError('invalid_email', 'email is not a valid address');
    }
    throw error;
  }
}

function assertGrantRole(role: string): CollaboratorGrantRole {
  if (role === 'editor' || role === 'viewer') return role;
  throw new CollaborationError('invalid_role', 'Collaborator grant role is not allowed.');
}

function assertActor(actor: CollaborationActor): CollaborationActor {
  if (!actor || actor.kind !== 'account') {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  assertNonEmpty(actor.principalId, 'actor.principalId');
  assertNonEmpty(actor.subjectId, 'actor.subjectId');
  assertNonEmpty(actor.email, 'actor.email');
  return actor;
}

function assertCommand(
  command: CollaborationCommand,
  defaultScope: string,
): { readonly commandId: string; readonly fingerprint: string; readonly commandScope: string } {
  if (!command || typeof command !== 'object') {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  let commandId: string;
  try {
    commandId = assertCanonicalCommandId(command.commandId);
  } catch {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  const fingerprint = assertNonEmpty(command.fingerprint, 'command.fingerprint');
  const commandScope = command.commandScope?.trim() || defaultScope;
  return { commandId, fingerprint, commandScope };
}

function assertNonEmpty(value: string, _field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollaborationError('conceal', 'Resource was not found.');
  }
  return value;
}

function toBinding(principalId: string, command: {
  readonly commandId: string;
  readonly commandScope: string;
}): ProductCommandBinding {
  return { principalId, commandScope: command.commandScope, commandId: command.commandId };
}

function toPrincipal(actor: CollaborationActor): ActorPrincipal {
  return { principalId: actor.principalId, subjectId: actor.subjectId, kind: 'account' };
}

function toInviteView(record: CollaborationInviteRecord): CollaborationInviteView {
  return {
    inviteId: record.id,
    collectionId: record.collectionId,
    role: record.role,
    email: record.emailNormalized,
    status: 'pending',
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function toMembershipView(record: CollaborationMembershipRecord): CollaborationMembershipView {
  if (record.role === 'owner') {
    throw new CollaborationError('owner_immutable', 'Owner membership cannot be changed.');
  }
  return {
    collectionId: record.collectionId,
    subjectId: record.subjectId,
    role: record.role,
    grantedAt: record.grantedAt.toISOString(),
  };
}

function toInviteCreatedBody(
  invite: CollaborationInviteView,
  policyRevision: string,
): {
  readonly inviteId: string;
  readonly collectionId: string;
  readonly role: CollaboratorGrantRole;
  readonly expiresAt: string;
  readonly policyEtag: string;
} {
  return {
    inviteId: invite.inviteId,
    collectionId: invite.collectionId,
    role: invite.role,
    expiresAt: invite.expiresAt,
    policyEtag: `"${policyRevision}"`,
  };
}

function toMembershipBody(
  membership: CollaborationMembershipView,
  policyRevision: string,
): CollaborationMembershipView & { readonly policyEtag: string } {
  return { ...membership, policyEtag: `"${policyRevision}"` };
}

async function writeAudit(
  ports: CollaborationCommandPorts,
  actor: CollaborationActor,
  now: Date,
  eventType: string,
  details: CollaborationAuditEvent['details'],
): Promise<void> {
  await ports.audit.append({
    principalId: actor.principalId,
    eventType,
    details,
    createdAt: now,
  });
}

async function complete(
  receipts: ProductCommandReceiptPort,
  binding: ProductCommandBinding,
  fingerprint: string,
  input: {
    readonly status: number;
    readonly body: Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
    readonly targetIdentity?: string;
  },
): Promise<void> {
  const result: ProductCommandResult = {
    status: input.status,
    body: input.body,
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      ...input.headers,
    },
    mediaType: 'application/json',
    contractVersion: COLLABORATION_COMMAND_CONTRACT_VERSION,
    targetIdentity: input.targetIdentity,
  };
  await receipts.complete(binding, fingerprint, result);
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function mapClaim(
  claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>,
): CollaborationCommandResult {
  if (claim.kind === 'replay') {
    return { kind: 'replay', ...claim.result };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
