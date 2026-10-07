/**
 * CS-04 community comment curation: getCommentCuration and
 * setCommentCuration — the curator hide/unhide overlay behind
 * GET|PUT /api/v1/community/comments/{commentId}/curation and
 * known.community.comment.curate.
 *
 * The overlay is one row per comment, created on the first curator write;
 * the absent row is the virtual default (`hidden=false`, revision '1',
 * `updatedAt` = the comment's own created_at). The independent curation
 * ETag compares verbatim in If-Match — a stale tag is 412
 * precondition_failed with the current tag attached. `hidden=false`
 * removes only this curator overlay: it never resurrects an author-deleted
 * tombstone and never touches `community_comments.state`.
 *
 * A curator is the target owner or an active owner/editor member of the
 * governing collection/series — never the comment author by virtue of
 * authorship alone.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type {
  CommunityTargetViewer,
  ResolvedCommunityTarget,
} from './community-target-query.js';
import type {
  CommunityTarget,
  CommunityTargetIdentity,
  CommunityTargetQuery,
} from './community-target.js';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_CURATION_FORBIDDEN_MESSAGE,
  COMMUNITY_CURATION_PRECONDITION_MESSAGE,
  CommunityCommentError,
  communityCurationEtag,
  communityCurationView,
  communityCurationVirtual,
  normalizeCommunityReason,
  type CommunityCommentCurationRecord,
  type CommunityCommentRecord,
  type CommunityCuration,
} from './community-comment.js';
import {
  COMMUNITY_COMMENT_CURATION_SCOPE,
  communityCommentInvalidRequest,
  communityCommentPreconditionFailed,
  lockCommentContext,
  manageResult,
  mapManageClaim,
  validateManageActor,
  validateManageCommandId,
  validateManageCommentId,
  validateManageIfMatch,
  type CommunityCommentManageActor,
  type CommunityCommentManagePorts,
  type CommunityCommentManageResult,
} from './community-comment-manage.js';

/** Read ports for getCommentCuration; the write command uses the shared manage ports. */
export interface CommunityCurationQueryPorts {
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
  };
  readonly comments: {
    findById(commentId: string): Promise<CommunityCommentRecord | null>;
  };
  readonly curators: {
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  readonly curations: {
    find(commentId: string): Promise<CommunityCommentCurationRecord | null>;
  };
}

export interface CommunityCommentCurationInput {
  readonly actor: CommunityCommentManageActor;
  readonly commentId: unknown;
  readonly hidden: unknown;
  readonly reason: unknown;
  readonly ifMatch: unknown;
  readonly commandId: string;
}

/** Normalized curation payload after closed-object validation. */
export interface CommunityCurationWrite {
  readonly hidden: boolean;
  readonly reason: string;
}

const CURATION_BODY_KEYS = ['hidden', 'reason'] as const;

function concealed(): CommunityCommentError {
  return new CommunityCommentError('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE);
}

function recordTargetQuery(record: CommunityCommentRecord): CommunityTargetQuery {
  const identity = record.target;
  return {
    kind: identity.kind,
    id: identity.id,
    ...(identity.collectionId !== null ? { collectionId: identity.collectionId } : {}),
    ...(identity.seriesId !== null ? { seriesId: identity.seriesId } : {}),
  };
}

/**
 * Parse the closed curation body {hidden, reason}. Unknown keys reject,
 * `hidden` must be a literal boolean, and `reason` is the required 1..1000
 * code-point justification — required for unhide writes too (it becomes
 * the stored last-write reason; the wire exposes it only while hidden).
 */
export function parseCommunityCurationBody(value: unknown): CommunityCurationWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw communityCommentInvalidRequest('The comment curation body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CURATION_BODY_KEYS.length
      || CURATION_BODY_KEYS.some((key) => !keys.includes(key))) {
    throw communityCommentInvalidRequest('The comment curation body is invalid.');
  }
  if (typeof record.hidden !== 'boolean') {
    throw communityCommentInvalidRequest('The comment curation hidden flag is invalid.');
  }
  return Object.freeze<CommunityCurationWrite>({
    hidden: record.hidden,
    reason: normalizeCommunityReason(record.reason),
  });
}

function authenticatedCurator(
  viewer: CommunityTargetViewer,
): asserts viewer is { accountId: string; subjectId: string } {
  if (viewer.accountId === null || viewer.subjectId === null) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE);
  }
}

/**
 * Read the curation overlay for one comment. The comment must exist on a
 * still-live target generation, then the viewer must be a curator of that
 * target — concealed resource_not_found hides the first condition,
 * insufficient_permission the second.
 */
export async function getCommentCuration(
  ports: CommunityCurationQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly commentId: string;
  },
): Promise<CommunityCuration> {
  const record = await ports.comments.findById(input.commentId);
  if (record === null) throw concealed();
  const resolved = await ports.targets.resolve(recordTargetQuery(record));
  if (resolved === null || record.targetGeneration !== resolved.target.generation) {
    throw concealed();
  }
  authenticatedCurator(input.viewer);
  if (!(await ports.curators.canCurate(record.target, input.viewer.subjectId))) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE);
  }
  const row = await ports.curations.find(record.id);
  return row === null
    ? communityCurationVirtual(record.id, record.createdAt)
    : communityCurationView(row);
}

export function communityCurationCommandFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly commentId: string;
  readonly hidden: boolean;
  readonly reason: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    commentId: input.commentId,
    hidden: input.hidden,
    reason: input.reason,
    contractVersion: '1.0.0',
  }), 'utf8').digest('hex');
}

/**
 * Curator hide/unhide: the actor must be a curator of the comment's target,
 * the If-Match tag must equal the current curation ETag (the virtual tag
 * before any write), and the new row revision increments the compared one.
 * Every write appends an immutable audit event.
 */
export async function setCommentCuration(
  ports: CommunityCommentManagePorts,
  input: CommunityCommentCurationInput,
): Promise<CommunityCommentManageResult<CommunityCuration>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw communityCommentInvalidRequest('Community curation command input is required.');
  }
  validateManageActor(input.actor);
  const commentId = validateManageCommentId(input.commentId);
  const write = parseCurationFields(input);
  const ifMatch = validateManageIfMatch(input.ifMatch);
  const commandId = validateManageCommandId(input.commandId);
  const fingerprint = communityCurationCommandFingerprint({
    actorPrincipalId: input.actor.principalId, commentId,
    hidden: write.hidden, reason: write.reason,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_COMMENT_CURATION_SCOPE,
    commandId,
  };
  const { record } = await lockCommentContext(ports, input.actor, commentId);
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapManageClaim(claim);
  if (!(await ports.curators.canCurate(record.target, input.actor.subjectId))) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE);
  }
  const existing = await ports.curations.lockByCommentId(record.id);
  const current = existing === null
    ? communityCurationVirtual(record.id, record.createdAt)
    : communityCurationView(existing);
  const currentEtag = communityCurationEtagKey(ports, current);
  if (ifMatch !== currentEtag) {
    throw communityCommentPreconditionFailed(COMMUNITY_CURATION_PRECONDITION_MESSAGE, currentEtag);
  }
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw communityCommentInvalidRequest('The command clock returned invalid time.');
  }
  const stored = await ports.curations.upsert(Object.freeze<CommunityCommentCurationRecord>({
    commentId: record.id,
    hidden: write.hidden,
    reason: write.reason,
    // The virtual default is revision '1'; the first stored row is 2.
    revision: (existing?.revision ?? 1n) + 1n,
    updatedByAccountId: input.actor.principalId,
    updatedAt: now,
  }));
  await ports.audit.append({
    eventType: 'community.comment_curation_updated',
    principalId: input.actor.principalId,
    details: {
      commentId: record.id,
      hidden: write.hidden,
      reason: write.reason,
      revision: stored.revision.toString(),
      targetKind: record.target.kind,
      targetId: record.target.id,
      targetCollectionId: record.target.collectionId,
      targetSeriesId: record.target.seriesId,
      targetGeneration: record.targetGeneration,
    },
    createdAt: now,
  });
  const curation = communityCurationView(stored);
  await ports.receipts.complete(binding, fingerprint,
    manageResult(curation, communityCurationEtagKey(ports, curation), `comment-curation:${record.id}`));
  return { kind: 'succeeded', value: curation };
}

function parseCurationFields(input: CommunityCommentCurationInput): CommunityCurationWrite {
  try {
    return parseCommunityCurationBody({ hidden: input.hidden, reason: input.reason });
  } catch (error) {
    if (error instanceof CommunityCommentError) {
      throw communityCommentInvalidRequest(error.message);
    }
    throw error;
  }
}

function communityCurationEtagKey(
  ports: CommunityCommentManagePorts,
  curation: CommunityCuration,
): string {
  // The manage ports inject only the comment ETag derivation; the curation
  // tag reuses the same configured key via the independent domain label.
  return ports.etags.curation(curation);
}
