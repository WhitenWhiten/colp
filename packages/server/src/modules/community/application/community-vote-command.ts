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
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  type ResolvedCommunityTarget,
} from './community-target-query.js';
import {
  CommunityTargetError,
  communityTargetIdentity,
  communityTargetMatches,
  parseCommunityTarget,
  parseCommunityVoteValue,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type CommunityVoteState,
  type CommunityVoteValue,
} from './community-target.js';

export const COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION = '1.0.0';
export const COMMUNITY_VOTE_COMMAND_SCOPE = 'community:vote-set:v1';
export const COMMUNITY_SELF_VOTE_MESSAGE = 'You cannot vote on your own content.';
export const COMMUNITY_TARGET_STALE_MESSAGE = 'The community target changed; resolve it again before voting.';

export type CommunityVoteCommandErrorCode =
  | 'invalid_request'
  | 'resource_not_found'
  | 'insufficient_permission'
  | 'revision_conflict';

export class CommunityVoteCommandError extends Error {
  constructor(readonly code: CommunityVoteCommandErrorCode, message: string) {
    super(message);
    this.name = 'CommunityVoteCommandError';
  }
}

export interface CommunityVoteCommandInput {
  readonly actor: {
    readonly principalId: string;
    readonly subjectId: string;
  };
  readonly target: unknown;
  readonly value: unknown;
  readonly commandId: string;
}

export type CommunityVoteCommandResult =
  | { readonly kind: 'succeeded'; readonly state: CommunityVoteState }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface CommunityVoteAuditEvent {
  readonly principalId: string;
  readonly target: CommunityTargetIdentity;
  readonly generation: string;
  readonly previousValue: CommunityVoteValue;
  readonly value: CommunityVoteValue;
  readonly changed: boolean;
  readonly createdAt: Date;
}

export interface CommunityVoteCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly actor: {
    /** Lock + verify the voter's account row is active; returns its subject id. */
    lockActiveAccount(accountId: string): Promise<{ readonly subjectId: string } | null>;
  };
  readonly targets: {
    /**
     * Resolve the eligible target with a FOR UPDATE lock on its authority row
     * (collection/node/digest row). The lock serializes vote reconciliation
     * per target so the counts computed in this transaction see every
     * previously committed vote; it never writes, so canonical revisions
     * do not move.
     */
    lockResolved(identity: CommunityTargetIdentity): Promise<ResolvedCommunityTarget | null>;
  };
  readonly votes: {
    lockOwn(
      accountId: string,
      identity: CommunityTargetIdentity,
    ): Promise<{ readonly value: CommunityVoteValue; readonly generation: string } | null>;
    upsert(
      accountId: string,
      identity: CommunityTargetIdentity,
      generation: string,
      value: 1 | -1,
    ): Promise<void>;
    remove(
      accountId: string,
      identity: CommunityTargetIdentity,
    ): Promise<void>;
    count(
      identity: CommunityTargetIdentity,
      generation: string,
    ): Promise<{ readonly up: number; readonly down: number }>;
  };
  readonly refreshes: {
    /**
     * Enqueue one durable hot-ranking rebuild inside this transaction.
     * Called only when the vote mutation actually changed the authority —
     * replays, reused/in_progress/expired claims and no-op votes never
     * enqueue, so every refresh pass corresponds to a real change instead
     * of amplifying a replay storm into repeated full rebuilds.
     */
    enqueue(): Promise<void>;
  };
  readonly audit: { append(event: CommunityVoteAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}

export function communityVoteCommandFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly target: CommunityTarget;
  readonly value: CommunityVoteValue;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    target: input.target,
    value: input.value,
    contractVersion: COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export async function setCommunityVote(
  ports: CommunityVoteCommandPorts,
  input: CommunityVoteCommandInput,
): Promise<CommunityVoteCommandResult> {
  const value = validateInput(input);
  const fingerprint = communityVoteCommandFingerprint({
    actorPrincipalId: value.actor.principalId,
    target: value.target,
    value: value.value,
  });
  const binding = {
    principalId: value.actor.principalId,
    commandScope: COMMUNITY_VOTE_COMMAND_SCOPE,
    commandId: value.commandId,
  };

  // Receipt order (contract x-wire-rules.receiptOrder): syntax and current
  // authentication/access first, then the durable claim/fingerprint check,
  // then fresh mutation preconditions. The account lock re-proves the
  // session's account is still active, and the target lock re-proves the
  // target is still live+eligible — a now-concealed target returns 404
  // before any saved receipt body can leak.
  const account = await ports.actor.lockActiveAccount(value.actor.principalId);
  if (account === null || account.subjectId !== value.actor.subjectId) {
    throw new CommunityVoteCommandError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
  }
  const resolved = await ports.targets.lockResolved(communityTargetIdentity(value.target));
  if (resolved === null) {
    throw new CommunityVoteCommandError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
  }

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  // Fresh preconditions apply only to new commands: an exact replay returns
  // the saved outcome even though the generation has since advanced.
  if (!communityTargetMatches(value.target, resolved.target)) {
    throw new CommunityVoteCommandError('revision_conflict', COMMUNITY_TARGET_STALE_MESSAGE);
  }
  if (resolved.ownerSubjectId === value.actor.subjectId) {
    throw new CommunityVoteCommandError('insufficient_permission', COMMUNITY_SELF_VOTE_MESSAGE);
  }

  const identity = communityTargetIdentity(resolved.target);
  const generation = resolved.target.generation;
  const current = await ports.votes.lockOwn(value.actor.principalId, identity);
  // A stored vote cast against a superseded generation no longer counts:
  // the effective previous value is 0 and the upsert rebinds the row to the
  // current generation.
  const previousValue: CommunityVoteValue =
    current !== null && current.generation === generation ? current.value : 0;
  const changed = previousValue !== value.value;
  if (changed) {
    if (value.value === 0) {
      await ports.votes.remove(value.actor.principalId, identity);
    } else {
      await ports.votes.upsert(value.actor.principalId, identity, generation, value.value);
    }
    await ports.refreshes.enqueue();
  }

  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CommunityVoteCommandError('invalid_request', 'The command clock returned invalid time.');
  }

  const counts = await ports.votes.count(identity, generation);
  await ports.audit.append({
    principalId: value.actor.principalId,
    target: identity,
    generation,
    previousValue,
    value: value.value,
    changed,
    createdAt: now,
  });

  const state = Object.freeze<CommunityVoteState>({
    target: resolved.target,
    up: counts.up,
    down: counts.down,
    myVote: value.value,
  });
  await ports.receipts.complete(binding, fingerprint, productResult(state));
  return { kind: 'succeeded', state };
}

interface ValidatedInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly target: CommunityTarget;
  readonly value: CommunityVoteValue;
  readonly commandId: string;
}

function validateInput(input: CommunityVoteCommandInput): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw new CommunityVoteCommandError('invalid_request', 'Community vote command input is required.');
  }
  for (const identity of [input.actor.principalId, input.actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw new CommunityVoteCommandError('invalid_request', 'Community vote actor identities are invalid.');
    }
  }
  let target: CommunityTarget;
  try {
    target = parseCommunityTarget(input.target);
  } catch (error) {
    if (error instanceof CommunityTargetError) {
      throw new CommunityVoteCommandError('invalid_request', error.message);
    }
    throw error;
  }
  let value: CommunityVoteValue;
  try {
    value = parseCommunityVoteValue(input.value);
  } catch (error) {
    if (error instanceof CommunityTargetError) {
      throw new CommunityVoteCommandError('invalid_request', error.message);
    }
    throw error;
  }
  try {
    assertCanonicalCommandId(input.commandId);
  } catch {
    throw new CommunityVoteCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return { actor: input.actor, target, value, commandId: input.commandId };
}

function productResult(state: CommunityVoteState): ProductCommandResult {
  const body = JSON.stringify({
    target: state.target,
    up: state.up,
    down: state.down,
    myVote: state.myVote,
  });
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
    targetIdentity: `${state.target.kind}:${state.target.id}`,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CommunityVoteCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
