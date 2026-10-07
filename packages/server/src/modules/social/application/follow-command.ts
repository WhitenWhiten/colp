import { createHash } from 'node:crypto';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import type { FollowRepository } from './follow-repository.js';

export const FOLLOW_COMMAND_CONTRACT_VERSION = '1.0.0';
export const FOLLOW_COMMAND_SCOPE = 'social:follow-relation:v1';
const PROFILE_IDENTITY = new RegExp(
  `^[A-Za-z0-9_-][A-Za-z0-9._~:-]{0,${SOCIAL_IDENTITY_MAX_LENGTH - 1}}$`,
);

export type FollowCommandAction = 'follow' | 'unfollow';
export type FollowCommandErrorCode = 'invalid_request' | 'resource_not_found';

export class FollowCommandError extends Error {
  constructor(readonly code: FollowCommandErrorCode, message: string) {
    super(message);
    this.name = 'FollowCommandError';
  }
}

export interface FollowCommandInput {
  readonly actor: {
    readonly principalId: string;
    readonly profileId: string;
  };
  readonly targetProfileId: string;
  readonly commandId: string;
}

export interface FollowRelationResult {
  readonly actorProfileId: string;
  readonly targetProfileId: string;
  readonly following: boolean;
  readonly changedAt: Date;
}

export type FollowCommandResult =
  | { readonly kind: 'succeeded'; readonly relation: FollowRelationResult }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface FollowAuditEvent {
  readonly principalId: string;
  readonly actorProfileId: string;
  readonly targetProfileId: string;
  readonly action: FollowCommandAction;
  readonly changed: boolean;
  readonly createdAt: Date;
}

export type FollowOutboxHandlerName =
  | 'social_follow_activity'
  | 'social_feed_follow_activity'
  | 'social_feed_withdrawal';

export interface FollowOutboxEvent {
  readonly outboxId: string;
  readonly eventId: string;
  readonly eventType: 'social.follow-created' | 'social.follow-removed';
  readonly eventVersion: 1;
  readonly handlerName: FollowOutboxHandlerName;
  readonly handlerMode: 'delivery_each_event';
  readonly actorProfileId: string;
  readonly targetProfileId: string;
  readonly occurredAt: Date;
  readonly payload: {
    readonly actorProfileId: string;
    readonly targetProfileId: string;
  };
}

export interface FollowCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly profiles: {
    lockEligiblePair(binding: {
      readonly actorPrincipalId: string;
      readonly actorProfileId: string;
      readonly targetProfileId: string;
    }): Promise<boolean>;
  };
  readonly follows: FollowRepository;
  readonly audit: { append(event: FollowAuditEvent): Promise<void> };
  readonly outbox: { appendAll(events: readonly FollowOutboxEvent[]): Promise<void> };
  readonly clock: { now(): Promise<Date> };
  readonly ids: { nextEventId(): string; nextOutboxId(): string };
}

export function followCommandFingerprint(
  action: FollowCommandAction,
  input: FollowCommandInput,
): string {
  const value = validateInput(input);
  return createHash('sha256').update(canonicalJson({
    action,
    actorPrincipalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
    targetProfileId: value.targetProfileId,
    contractVersion: FOLLOW_COMMAND_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export function followProfile(
  ports: FollowCommandPorts,
  input: FollowCommandInput,
): Promise<FollowCommandResult> {
  return executeFollowCommand(ports, input, 'follow');
}

export function unfollowProfile(
  ports: FollowCommandPorts,
  input: FollowCommandInput,
): Promise<FollowCommandResult> {
  return executeFollowCommand(ports, input, 'unfollow');
}

async function executeFollowCommand(
  ports: FollowCommandPorts,
  input: FollowCommandInput,
  action: FollowCommandAction,
): Promise<FollowCommandResult> {
  const value = validateInput(input);
  const fingerprint = followCommandFingerprint(action, value);
  const binding = {
    principalId: value.actor.principalId,
    commandScope: FOLLOW_COMMAND_SCOPE,
    commandId: value.commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const profilesEligible = await ports.profiles.lockEligiblePair({
    actorPrincipalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
    targetProfileId: value.targetProfileId,
  });
  if (!profilesEligible) {
    throw new FollowCommandError('resource_not_found', 'The Profile was not found.');
  }

  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new FollowCommandError('invalid_request', 'The command clock returned invalid time.');
  }

  let changed: boolean;
  let changedAt: Date;
  if (action === 'follow') {
    const saved = await ports.follows.save({
      actorProfileId: value.actor.profileId,
      targetProfileId: value.targetProfileId,
    });
    if (!saved) throw new FollowCommandError('resource_not_found', 'The Profile was not found.');
    changed = saved.inserted;
    changedAt = saved.follow.followedAt;
  } else {
    changed = await ports.follows.remove({
      actorProfileId: value.actor.profileId,
      targetProfileId: value.targetProfileId,
    });
    changedAt = now;
  }

  await ports.audit.append({
    principalId: value.actor.principalId,
    actorProfileId: value.actor.profileId,
    targetProfileId: value.targetProfileId,
    action,
    changed,
    createdAt: now,
  });

  if (changed) {
    const eventId = ports.ids.nextEventId();
    const shared = {
      eventId,
      eventVersion: 1 as const,
      handlerMode: 'delivery_each_event' as const,
      actorProfileId: value.actor.profileId,
      targetProfileId: value.targetProfileId,
      occurredAt: now,
      payload: {
        actorProfileId: value.actor.profileId,
        targetProfileId: value.targetProfileId,
      },
    };
    if (action === 'follow') {
      await ports.outbox.appendAll([
        {
          ...shared,
          outboxId: ports.ids.nextOutboxId(),
          eventType: 'social.follow-created',
          handlerName: 'social_follow_activity',
        },
        {
          ...shared,
          outboxId: ports.ids.nextOutboxId(),
          eventType: 'social.follow-created',
          handlerName: 'social_feed_follow_activity',
        },
      ]);
    } else {
      await ports.outbox.appendAll([
        {
          ...shared,
          outboxId: ports.ids.nextOutboxId(),
          eventType: 'social.follow-removed',
          handlerName: 'social_follow_activity',
        },
        {
          ...shared,
          outboxId: ports.ids.nextOutboxId(),
          eventType: 'social.follow-removed',
          handlerName: 'social_feed_withdrawal',
        },
      ]);
    }
  }

  const relation = Object.freeze({
    actorProfileId: value.actor.profileId,
    targetProfileId: value.targetProfileId,
    following: action === 'follow',
    changedAt,
  });
  await ports.receipts.complete(binding, fingerprint, productResult(relation));
  return { kind: 'succeeded', relation };
}

function validateInput(input: FollowCommandInput): FollowCommandInput {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw new FollowCommandError('invalid_request', 'Follow command input is required.');
  }
  for (const identity of [input.actor.profileId, input.targetProfileId]) {
    if (typeof identity !== 'string' || !PROFILE_IDENTITY.test(identity)) {
      throw new FollowCommandError('invalid_request', 'Follow command identities are invalid.');
    }
  }
  if (typeof input.actor.principalId !== 'string' || input.actor.principalId.length < 1
      || input.actor.principalId.length > SOCIAL_IDENTITY_MAX_LENGTH
      || input.actor.principalId.trim() !== input.actor.principalId) {
    throw new FollowCommandError('invalid_request', 'Follow command identities are invalid.');
  }
  if (input.actor.profileId === input.targetProfileId) {
    throw new FollowCommandError('invalid_request', 'A Profile cannot follow itself.');
  }
  try {
    assertCanonicalCommandId(input.commandId);
  } catch {
    throw new FollowCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return input;
}

function productResult(relation: FollowRelationResult): ProductCommandResult {
  const body = JSON.stringify({
    actorProfileId: relation.actorProfileId,
    targetProfileId: relation.targetProfileId,
    following: relation.following,
    changedAt: relation.changedAt.toISOString(),
  });
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: FOLLOW_COMMAND_CONTRACT_VERSION,
    targetIdentity: relation.targetProfileId,
  };
}

function mapClaim(claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>): FollowCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
