import { createHash } from 'node:crypto';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionFollowAuthorityError,
  type CollectionFollowRepository,
} from './collection-follow-repository.js';

export const COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION = '1.0.0';
export const COLLECTION_FOLLOW_COMMAND_SCOPE = 'social:collection-follow-relation:v1';
export const COLLECTION_OWNER_FOLLOW_MESSAGE = 'A Collection owner cannot follow their own collection.';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const PROFILE_IDENTITY = new RegExp(
  `^[A-Za-z0-9_-][A-Za-z0-9._~:-]{0,${SOCIAL_IDENTITY_MAX_LENGTH - 1}}$`,
);

export type CollectionFollowCommandAction = 'follow' | 'unfollow';
export type CollectionFollowCommandErrorCode = 'invalid_request' | 'resource_not_found';

export class CollectionFollowCommandError extends Error {
  constructor(readonly code: CollectionFollowCommandErrorCode, message: string) {
    super(message);
    this.name = 'CollectionFollowCommandError';
  }
}

export interface CollectionFollowCommandInput {
  readonly actor: {
    readonly principalId: string;
    readonly profileId: string;
    readonly subjectId: string;
  };
  readonly collectionId: string;
  readonly commandId: string;
  readonly subscriptionExitPreviewId?: string;
}

export interface CollectionFollowStateResult {
  readonly following: boolean;
  readonly followerCount: number;
  readonly followedAt: Date | null;
}

export type CollectionFollowCommandResult =
  | { readonly kind: 'succeeded'; readonly state: CollectionFollowStateResult }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface CollectionFollowAuditEvent {
  readonly principalId: string;
  readonly actorProfileId: string;
  readonly collectionId: string;
  readonly action: CollectionFollowCommandAction;
  readonly changed: boolean;
  readonly createdAt: Date;
}

export interface CollectionFollowCommandPorts {
  readonly subscriptionExit?: { lockAccount(accountId:string):Promise<void>; unfollow(input:{accountId:string;subjectId:string;source:{sourceType:'collection';sourceId:string};previewId?:string}):Promise<void> };
  readonly receipts: ProductCommandReceiptPort;
  readonly actor: {
    lockActiveProfile(binding: {
      readonly actorPrincipalId: string;
      readonly actorProfileId: string;
    }): Promise<boolean>;
  };
  readonly collection: {
    lockFollowable(collectionId: string): Promise<
      | { readonly kind: 'followable'; readonly ownerSubjectId: string }
      | { readonly kind: 'not_found' }
    >;
  };
  readonly follows: CollectionFollowRepository;
  readonly audit: { append(event: CollectionFollowAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}

export function collectionFollowCommandFingerprint(
  action: CollectionFollowCommandAction,
  input: CollectionFollowCommandInput,
): string {
  const value = validateInput(input);
  return createHash('sha256').update(canonicalJson({
    action,
    actorPrincipalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
    collectionId: value.collectionId,
    contractVersion: COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION,
    ...(value.subscriptionExitPreviewId !== undefined ? { subscriptionExitPreviewId: value.subscriptionExitPreviewId } : {}),
  }), 'utf8').digest('hex');
}

export function followCollection(
  ports: CollectionFollowCommandPorts,
  input: CollectionFollowCommandInput,
): Promise<CollectionFollowCommandResult> {
  return executeCollectionFollowCommand(ports, input, 'follow');
}

export function unfollowCollection(
  ports: CollectionFollowCommandPorts,
  input: CollectionFollowCommandInput,
): Promise<CollectionFollowCommandResult> {
  return executeCollectionFollowCommand(ports, input, 'unfollow');
}

async function executeCollectionFollowCommand(
  ports: CollectionFollowCommandPorts,
  input: CollectionFollowCommandInput,
  action: CollectionFollowCommandAction,
): Promise<CollectionFollowCommandResult> {
  const value = validateInput(input);
  const fingerprint = collectionFollowCommandFingerprint(action, value);
  const binding = {
    principalId: value.actor.principalId,
    commandScope: COLLECTION_FOLLOW_COMMAND_SCOPE,
    commandId: value.commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  await ports.subscriptionExit?.lockAccount(value.actor.principalId);

  const actorEligible = await ports.actor.lockActiveProfile({
    actorPrincipalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
  });
  if (!actorEligible) {
    throw new CollectionFollowCommandError('resource_not_found', 'The Collection was not found.');
  }

  let followedAt: Date | null = null;
  let changed: boolean;
  let targetVisible: boolean;
  if (action === 'follow') {
    const target = await ports.collection.lockFollowable(value.collectionId);
    if (target.kind === 'not_found') {
      throw new CollectionFollowCommandError('resource_not_found', 'The Collection was not found.');
    }
    if (target.ownerSubjectId === value.actor.subjectId) {
      throw new CollectionFollowCommandError('invalid_request', COLLECTION_OWNER_FOLLOW_MESSAGE);
    }
    targetVisible = true;
    let saved;
    try {
      saved = await ports.follows.save({
        collectionId: value.collectionId,
        followerProfileId: value.actor.profileId,
      });
    } catch (error) {
      if (error instanceof CollectionFollowAuthorityError && error.code === 'owner_follow') {
        throw new CollectionFollowCommandError('invalid_request', COLLECTION_OWNER_FOLLOW_MESSAGE);
      }
      throw error;
    }
    if (!saved) throw new CollectionFollowCommandError('resource_not_found', 'The Collection was not found.');
    changed = saved.inserted;
    followedAt = saved.follow.followedAt;
  } else {
    // Unfollow stays lenient so followers of a target that went dark can
    // still clean up their own edge, but the live follower count of an
    // invisible collection must never surface here — that would let any
    // session bypass the resource_not_found concealment of PUT/GET with a
    // free DELETE probe.
    const target = await ports.collection.lockFollowable(value.collectionId);
    targetVisible = target.kind === 'followable';
    changed = await ports.follows.remove({
      collectionId: value.collectionId,
      followerProfileId: value.actor.profileId,
    });
  }

  if (action === 'unfollow') await ports.subscriptionExit?.unfollow({accountId:value.actor.principalId,subjectId:value.actor.subjectId,source:{sourceType:'collection',sourceId:value.collectionId},...(value.subscriptionExitPreviewId ? {previewId:value.subscriptionExitPreviewId} : {})});
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CollectionFollowCommandError('invalid_request', 'The command clock returned invalid time.');
  }

  const followerCount = targetVisible
    ? await ports.follows.countFollowers(value.collectionId)
    : 0;
  await ports.audit.append({
    principalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
    collectionId: value.collectionId,
    action,
    changed,
    createdAt: now,
  });

  const state = Object.freeze({
    following: action === 'follow',
    followerCount,
    followedAt: action === 'follow' ? followedAt : null,
  });
  await ports.receipts.complete(binding, fingerprint, productResult(state, value.collectionId));
  return { kind: 'succeeded', state };
}

function validateInput(input: CollectionFollowCommandInput): CollectionFollowCommandInput {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw new CollectionFollowCommandError('invalid_request', 'Collection Follow command input is required.');
  }
  if (typeof input.actor.profileId !== 'string' || !PROFILE_IDENTITY.test(input.actor.profileId)
      || !OPAQUE_ID.test(input.collectionId)) {
    throw new CollectionFollowCommandError('invalid_request', 'Collection Follow command identities are invalid.');
  }
  for (const identity of [input.actor.principalId, input.actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw new CollectionFollowCommandError('invalid_request', 'Collection Follow command identities are invalid.');
    }
  }
  try {
    assertCanonicalCommandId(input.commandId);
    if(input.subscriptionExitPreviewId !== undefined) assertCanonicalCommandId(input.subscriptionExitPreviewId);
  } catch {
    throw new CollectionFollowCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return input;
}

function productResult(state: CollectionFollowStateResult, collectionId: string): ProductCommandResult {
  const body = JSON.stringify({
    following: state.following,
    followerCount: state.followerCount,
    followedAt: state.followedAt === null ? null : state.followedAt.toISOString(),
  });
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: COLLECTION_FOLLOW_COMMAND_CONTRACT_VERSION,
    targetIdentity: collectionId,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CollectionFollowCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
