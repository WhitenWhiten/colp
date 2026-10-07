/**
 * CS-03 community comment creation: the durable createCommunityComment
 * command behind POST /api/v1/community/comments and
 * known.community.comment.create.
 *
 * Receipt order (contract x-wire-rules.receiptOrder): request syntax and
 * current authentication/object access first — the account lock re-proves
 * the session account is still active and the target lock re-proves the
 * target is still live and eligible (a now-concealed target is 404 before
 * any saved receipt body can leak) — then the durable claim/fingerprint
 * check, then fresh mutation preconditions. An exact Known-Command-Id
 * replay returns the saved 201 + Comment + ETag even after the generation
 * has since advanced; a changed fingerprint is 409 command_id_reused.
 *
 * A supplied target must equal the currently resolved Target identity AND
 * generation; a stale bookmark generation is 409 revision_conflict so the
 * caller resolves again and confirms intent on the new content. For a
 * reply (`replyToId` non-null) the parent row is locked FOR UPDATE and
 * must be a visible comment on the same target identity and generation —
 * any other outcome is the concealed resource_not_found — and depth 2 is
 * the ceiling: replying to a depth-2 comment is invalid_request (depth 3
 * is structurally impossible). The new row binds the resolved generation;
 * roots self-root (`rootId === id`, `replyToId === null`, `depth = 0`).
 */
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
import type { CommunityTargetViewer } from './community-target-query.js';
import {
  CommunityTargetError,
  communityTargetIdentity,
  communityTargetMatches,
  type CommunityTarget,
  type CommunityTargetIdentity,
} from './community-target.js';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_DEPTH_MESSAGE,
  COMMUNITY_COMMENT_LOCKED_MESSAGE,
  COMMUNITY_COMMENT_MAX_DEPTH,
  COMMUNITY_COMMENT_TARGET_STALE_MESSAGE,
  COMMUNITY_REPLY_TARGET_MISMATCH_MESSAGE,
  CommunityCommentError,
  communityCommentAuthorView,
  communityCommentEffectiveState,
  communityCommentView,
  parseCommunityCommentCreateBody,
  type CommunityComment,
  type CommunityCommentCreateInput,
  type CommunityCommentRecord,
  type CommunityCommentSettingsRecord,
} from './community-comment.js';
import { communityReplyNotificationRecipients } from './community-notification.js';
import type { CommunityCommentLiveAuthor } from './community-comment-query.js';

export const COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION = '1.0.0';
export const COMMUNITY_COMMENT_COMMAND_SCOPE = 'community:comment-create:v1';

export interface CommunityCommentCommandInput {
  readonly actor: {
    readonly principalId: string;
    readonly subjectId: string;
  };
  readonly target: unknown;
  readonly body: unknown;
  readonly replyToId: unknown;
  readonly commandId: string;
}

export type CommunityCommentCommandResult =
  | { readonly kind: 'succeeded'; readonly comment: CommunityComment }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface CommunityCommentAuditEvent {
  readonly principalId: string;
  readonly commentId: string;
  readonly target: CommunityTargetIdentity;
  readonly generation: string;
  readonly rootId: string;
  readonly replyToId: string | null;
  readonly depth: number;
  readonly createdAt: Date;
}

export interface CommunityCommentCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly actor: {
    /** Lock + verify the author's account row is active; returns its subject id. */
    lockActiveAccount(accountId: string): Promise<{ readonly subjectId: string } | null>;
  };
  readonly targets: {
    /**
     * Resolve the eligible target with a FOR UPDATE lock on its authority
     * row so reply validation and the write serialize against concurrent
     * comment writes on the same target.
     */
    lockResolved(identity: CommunityTargetIdentity): Promise<ResolvedCommunityTarget | null>;
  };
  readonly comments: {
    /** Lock the reply target row FOR UPDATE; null when it does not exist. */
    lockReplyTarget(commentId: string): Promise<CommunityCommentRecord | null>;
    /**
     * Insert the durable comment row. The implementation also reserves the
     * minted id in `resource_id_ledger` inside the same transaction so a
     * never-registered id cannot exist.
     */
    insert(record: CommunityCommentRecord): Promise<void>;
  };
  readonly authors: {
    publicActors(accountIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentLiveAuthor>>;
  };
  /** CS-04: target owner/editor predicate behind the `canCurate` hint. */
  readonly curators: {
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  /**
   * CS-04: per-target comment-area settings. `locked=true` rejects the
   * write for everyone — checked after generation fencing, before insert.
   */
  readonly settings: {
    find(identity: CommunityTargetIdentity): Promise<CommunityCommentSettingsRecord | null>;
  };
  /**
   * CS-05: durable reply-notification producer. `ownerAccountId` resolves
   * the active account behind the resolved target's owner subject (null
   * when the owner account is gone); `append` writes one
   * `community.comment-created` outbox event for one recipient inside this
   * transaction — durable with the comment row, never process-local.
   */
  readonly notifications: {
    ownerAccountId(ownerSubjectId: string): Promise<string | null>;
    append(input: {
      readonly comment: CommunityCommentRecord;
      readonly recipientAccountId: string;
    }): Promise<void>;
  };
  /** Mint a fresh opaque comment id (ledger reservation happens in insert). */
  readonly ids: { next(): string };
  /** Strong opaque ETag for the stored Comment (injected; the key stays in composition). */
  readonly etags: { for(comment: CommunityComment): string };
  readonly audit: { append(event: CommunityCommentAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}

export function communityCommentCommandFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly target: CommunityTarget;
  readonly body: string;
  readonly replyToId: string | null;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    target: input.target,
    body: input.body,
    replyToId: input.replyToId,
    contractVersion: COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

function notFound(): CommunityCommentError {
  return new CommunityCommentError('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE);
}

export async function createCommunityComment(
  ports: CommunityCommentCommandPorts,
  input: CommunityCommentCommandInput,
): Promise<CommunityCommentCommandResult> {
  const value = validateInput(input);
  const fingerprint = communityCommentCommandFingerprint({
    actorPrincipalId: value.actor.principalId,
    target: value.target,
    body: value.body,
    replyToId: value.replyToId,
  });
  const binding = {
    principalId: value.actor.principalId,
    commandScope: COMMUNITY_COMMENT_COMMAND_SCOPE,
    commandId: value.commandId,
  };

  const account = await ports.actor.lockActiveAccount(value.actor.principalId);
  if (account === null || account.subjectId !== value.actor.subjectId) {
    throw new CommunityCommentError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
  }
  const resolved = await ports.targets.lockResolved(communityTargetIdentity(value.target));
  if (resolved === null) throw notFound();

  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  // Fresh preconditions apply only to new commands: an exact replay returns
  // the saved outcome even though the generation has since advanced.
  if (!communityTargetMatches(value.target, resolved.target)) {
    throw new CommunityCommentError('revision_conflict', COMMUNITY_COMMENT_TARGET_STALE_MESSAGE);
  }
  const resolvedIdentity = communityTargetIdentity(resolved.target);
  // CS-04: a locked comment area rejects every new write on the target.
  const settings = await ports.settings.find(resolvedIdentity);
  if (settings !== null && settings.locked) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_COMMENT_LOCKED_MESSAGE);
  }

  const commentId = ports.ids.next();
  let rootId: string;
  let replyToId: string | null;
  let depth: number;
  let parentAuthorAccountId: string | null = null;
  if (value.replyToId === null) {
    rootId = commentId;
    replyToId = null;
    depth = 0;
  } else {
    const parent = await ports.comments.lockReplyTarget(value.replyToId);
    if (parent === null
        || communityCommentEffectiveState(parent) !== 'visible'
        || parent.targetGeneration !== resolved.target.generation
        || !sameTargetIdentity(parent.target, resolved.target)) {
      throw new CommunityCommentError('resource_not_found', COMMUNITY_REPLY_TARGET_MISMATCH_MESSAGE);
    }
    if (parent.depth >= COMMUNITY_COMMENT_MAX_DEPTH) {
      throw new CommunityCommentError('invalid_request', COMMUNITY_COMMENT_DEPTH_MESSAGE);
    }
    rootId = parent.rootId;
    replyToId = parent.id;
    depth = parent.depth + 1;
    parentAuthorAccountId = parent.authorAccountId;
  }

  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CommunityCommentError('invalid_request', 'The command clock returned invalid time.');
  }
  const record = Object.freeze<CommunityCommentRecord>({
    id: commentId,
    target: communityTargetIdentity(resolved.target),
    targetGeneration: resolved.target.generation,
    rootId,
    replyToId,
    depth,
    authorAccountId: value.actor.principalId,
    body: value.body,
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: now,
    updatedAt: now,
  });
  await ports.comments.insert(record);
  // CS-05: append one durable reply-notification event per eligible
  // recipient inside the same commit — the outbox row is the durable fact;
  // the worker re-proves every fact before projecting.
  const ownerAccountId = await ports.notifications.ownerAccountId(resolved.ownerSubjectId);
  for (const recipientAccountId of communityReplyNotificationRecipients({
    actorAccountId: value.actor.principalId,
    ownerAccountId,
    parentAuthorAccountId,
  })) {
    await ports.notifications.append({ comment: record, recipientAccountId });
  }
  await ports.audit.append({
    principalId: value.actor.principalId,
    commentId,
    target: record.target,
    generation: record.targetGeneration,
    rootId,
    replyToId,
    depth,
    createdAt: now,
  });
  const authors = await ports.authors.publicActors([value.actor.principalId]);
  const viewer: CommunityTargetViewer = {
    accountId: value.actor.principalId,
    subjectId: value.actor.subjectId,
  };
  const viewerCurates = await ports.curators.canCurate(resolvedIdentity, value.actor.subjectId);
  const comment = communityCommentView(record, {
    viewer,
    author: communityCommentAuthorView(value.actor.principalId, authors.get(value.actor.principalId) ?? null),
    replyCount: 0,
    viewerCurates,
  });
  await ports.receipts.complete(binding, fingerprint, productResult(comment, ports.etags.for(comment)));
  return { kind: 'succeeded', comment };
}

function sameTargetIdentity(identity: CommunityTargetIdentity, target: CommunityTarget): boolean {
  return identity.kind === target.kind
    && identity.id === target.id
    && identity.collectionId === target.collectionId
    && identity.seriesId === target.seriesId;
}

interface ValidatedInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly target: CommunityTarget;
  readonly body: string;
  readonly replyToId: string | null;
  readonly commandId: string;
}

function validateInput(input: CommunityCommentCommandInput): ValidatedInput {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw new CommunityCommentError('invalid_request', 'Community comment command input is required.');
  }
  for (const identity of [input.actor.principalId, input.actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw new CommunityCommentError('invalid_request', 'Community comment actor identities are invalid.');
    }
  }
  let parsed: CommunityCommentCreateInput;
  try {
    parsed = parseCommunityCommentCreateBody({
      target: input.target,
      body: input.body,
      replyToId: input.replyToId,
    });
  } catch (error) {
    if (error instanceof CommunityCommentError || error instanceof CommunityTargetError) {
      throw new CommunityCommentError('invalid_request', error.message);
    }
    throw error;
  }
  try {
    assertCanonicalCommandId(input.commandId);
  } catch {
    throw new CommunityCommentError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return {
    actor: input.actor,
    target: parsed.target,
    body: parsed.body,
    replyToId: parsed.replyToId,
    commandId: input.commandId,
  };
}

function productResult(comment: CommunityComment, etag: string): ProductCommandResult {
  return {
    status: 201,
    body: Buffer.from(JSON.stringify(comment), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      etag,
    },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
    targetIdentity: `comment:${comment.id}`,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CommunityCommentCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
