/**
 * CS-04 community comment management: author edit and author soft deletion
 * plus the shared write ports that also serve the curation and comment-area
 * settings commands (`community-comment-curation.ts`,
 * `community-comment-settings.ts`).
 *
 * Every CS-04 mutation follows the same receipt order as CS-03 creation:
 * request syntax and current authentication/object access first — the
 * account lock re-proves the session account is still active, the comment
 * row lock re-proves it still exists, and the target lock re-proves the
 * target is still live and on the generation the comment was written
 * against — then the durable claim/fingerprint check, then fresh
 * preconditions (authorship or curator authority, the If-Match entity-tag
 * compare). An exact Known-Command-Id replay returns the saved 200 +
 * representation + ETag even though the revision has since advanced; a
 * changed fingerprint is 409 command_id_reused.
 *
 * Three independent revision/ETag authorities exist by design and are never
 * interchangeable: `community_comments.revision` (author edit/delete),
 * `community_comment_curations.revision` (curator hide/unhide), and
 * `community_comment_settings.revision` (comment-area lock). Each command
 * CAS-es on its own authority only; a stale tag is 412 precondition_failed
 * with the current tag attached for refresh_and_retry.
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
  type CommunityTargetViewer,
  type ResolvedCommunityTarget,
} from './community-target-query.js';
import {
  communityTargetIdentity,
  type CommunityTargetIdentity,
} from './community-target.js';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE,
  COMMUNITY_COMMENT_NOT_DELETABLE_MESSAGE,
  COMMUNITY_COMMENT_NOT_EDITABLE_MESSAGE,
  COMMUNITY_COMMENT_PRECONDITION_MESSAGE,
  CommunityCommentError,
  communityCommentAuthorView,
  communityCommentEffectiveState,
  communityCommentView,
  isCommunityOpaqueId,
  parseCommunityCommentEditBody,
  type CommunityComment,
  type CommunityCommentCurationRecord,
  type CommunityCommentRecord,
  type CommunityCommentSettings,
  type CommunityCommentSettingsRecord,
  type CommunityCuration,
} from './community-comment.js';
import type { CommunityCommentLiveAuthor } from './community-comment-query.js';

export const COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION = '1.0.0';
export const COMMUNITY_COMMENT_EDIT_SCOPE = 'community:comment-edit:v1';
export const COMMUNITY_COMMENT_DELETE_SCOPE = 'community:comment-delete:v1';
export const COMMUNITY_COMMENT_CURATION_SCOPE = 'community:comment-curate:v1';
export const COMMUNITY_COMMENT_SETTINGS_SCOPE = 'community:comment-settings:v1';

const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/;

export interface CommunityCommentManageActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export type CommunityCommentManageResult<Value> =
  | { readonly kind: 'succeeded'; readonly value: Value }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface CommunityCommentEditInput {
  readonly actor: CommunityCommentManageActor;
  readonly commentId: unknown;
  readonly body: unknown;
  readonly ifMatch: unknown;
  readonly commandId: string;
}

export interface CommunityCommentDeleteInput {
  readonly actor: CommunityCommentManageActor;
  readonly commentId: unknown;
  readonly ifMatch: unknown;
  readonly commandId: string;
}

/**
 * Immutable audit event for one CS-04 write. `details` carries only
 * operation facts (ids, target identity, revisions, flags, reason) — never
 * the deleted comment body.
 */
export interface CommunityCommentManageAuditEvent {
  readonly eventType:
    | 'community.comment_edited'
    | 'community.comment_deleted'
    | 'community.comment_curation_updated'
    | 'community.comment_settings_updated';
  readonly principalId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/** Write ports shared by all four CS-04 mutation commands. */
export interface CommunityCommentManagePorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly actor: {
    /** Lock + verify the actor's account row is active; returns its subject id. */
    lockActiveAccount(accountId: string): Promise<{ readonly subjectId: string } | null>;
  };
  readonly targets: {
    /** Resolve + FOR UPDATE lock the live community-eligible target authority row. */
    lockResolved(identity: CommunityTargetIdentity): Promise<ResolvedCommunityTarget | null>;
  };
  readonly comments: {
    /** Read one comment WITHOUT locking — the immutable target-identity probe. */
    findById(commentId: string): Promise<CommunityCommentRecord | null>;
    /** Lock the comment row FOR UPDATE; null when it does not exist. */
    lockById(commentId: string): Promise<CommunityCommentRecord | null>;
    /**
     * CAS body/state update fenced on the expected durable revision.
     * Returns the fresh record; null on the revision miss.
     */
    update(
      commentId: string,
      expectedRevision: bigint,
      write: { readonly body: string | null; readonly state: 'visible' | 'deleted' },
      updatedAt: Date,
    ): Promise<CommunityCommentRecord | null>;
    /** Per root id: count of visible rows with `root_id = id AND depth > 0`. */
    countVisibleThreadReplies(rootIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
    /** Per comment id: count of visible rows with `reply_to_id = id`. */
    countVisibleDirectReplies(commentIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  };
  readonly curations: {
    /** Lock the curation overlay row FOR UPDATE; null when never written. */
    lockByCommentId(commentId: string): Promise<CommunityCommentCurationRecord | null>;
    /** Insert or replace the singleton overlay at the supplied revision. */
    upsert(record: CommunityCommentCurationRecord): Promise<CommunityCommentCurationRecord>;
  };
  readonly settings: {
    /** Lock the comment-area settings row FOR UPDATE; null when never written. */
    lockByTarget(identity: CommunityTargetIdentity): Promise<CommunityCommentSettingsRecord | null>;
    /** Insert or replace the singleton settings row at the supplied revision. */
    upsert(record: CommunityCommentSettingsRecord): Promise<CommunityCommentSettingsRecord>;
  };
  readonly curators: {
    /** Target owner OR active owner/editor member of the governing collection/series. */
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  readonly authors: {
    publicActors(accountIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentLiveAuthor>>;
  };
  /**
   * Strong opaque ETag derivations for all three CS-04 authorities
   * (injected; the configured HMAC key stays in composition).
   */
  readonly etags: {
    for(comment: Pick<CommunityComment, 'id' | 'revision'>): string;
    curation(curation: Pick<CommunityCuration, 'commentId' | 'revision'>): string;
    settings(settings: Pick<CommunityCommentSettings, 'target' | 'revision'>): string;
  };
  readonly audit: { append(event: CommunityCommentManageAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}

export function communityCommentEditFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly commentId: string;
  readonly body: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    commentId: input.commentId,
    body: input.body,
    contractVersion: COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export function communityCommentDeleteFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly commentId: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    commentId: input.commentId,
    contractVersion: COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export function communityCommentConcealed(): CommunityCommentError {
  return new CommunityCommentError('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE);
}

export function communityCommentInvalidRequest(message: string): CommunityCommentError {
  return new CommunityCommentError('invalid_request', message);
}

export function communityCommentPreconditionFailed(
  message: string,
  currentEtag: string,
): CommunityCommentError {
  return new CommunityCommentError('precondition_failed', message, { currentEtag });
}

function concealed(): CommunityCommentError {
  return communityCommentConcealed();
}

function invalidRequest(message: string): CommunityCommentError {
  return communityCommentInvalidRequest(message);
}

function preconditionFailed(currentEtag: string): CommunityCommentError {
  return communityCommentPreconditionFailed(COMMUNITY_COMMENT_PRECONDITION_MESSAGE, currentEtag);
}

export function validateManageActor(actor: CommunityCommentManageActor): void {
  for (const identity of [actor.principalId, actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw invalidRequest('Community comment actor identities are invalid.');
    }
  }
}

export function validateManageCommentId(value: unknown): string {
  if (!isCommunityOpaqueId(value)) {
    throw invalidRequest('The community comment id is invalid.');
  }
  return value;
}

export function validateManageIfMatch(value: unknown): string {
  if (typeof value !== 'string' || !STRONG_ENTITY_TAG.test(value)) {
    throw invalidRequest('If-Match must be a single strong entity-tag.');
  }
  return value;
}

export function validateManageCommandId(value: string): string {
  try {
    return assertCanonicalCommandId(value);
  } catch {
    throw invalidRequest('commandId must be a canonical UUID v4.');
  }
}

const validateCommentId = validateManageCommentId;
const validateIfMatch = validateManageIfMatch;
const validateCommandId = validateManageCommandId;

export interface LockedCommentContext {
  readonly record: CommunityCommentRecord;
  readonly resolved: ResolvedCommunityTarget;
}

/**
 * Authenticate + lock the comment and its CURRENT target. The comment must
 * exist, its target must still resolve, and the generation it was written
 * against must still be the resolved generation — every other outcome is
 * the same concealed resource_not_found (identical to getCommunityComment).
 *
 * Lock order is unified across every comment write command: the target row
 * is locked BEFORE any comment row. The create-reply chain locks the target
 * first (community-comment-command.ts), so locking the target before the
 * comment here too prevents the reply/editor lock-order inversion deadlock.
 * The comment's target identity is immutable (written once at creation), so
 * an unlocked probe read picks the target before either lock is taken; the
 * row is re-read FOR UPDATE afterwards and re-verified against the resolved
 * generation.
 */
/** CS-C05: after a CAS miss the supplied 412 must carry the FRESH revision's
 * etag (the durable row already moved on), not the stale pre-write one, so a
 * refresh_and_retry client retries against the true current state. */
async function freshCommentEtagAfterCasMiss(
  ports: CommunityCommentManagePorts,
  record: CommunityCommentRecord,
  currentEtag: string,
): Promise<string> {
  const fresh = await ports.comments.lockById(record.id);
  return fresh === null
    ? currentEtag
    : ports.etags.for({ id: fresh.id, revision: fresh.revision.toString() });
}

export async function lockCommentContext(
  ports: CommunityCommentManagePorts,
  actor: CommunityCommentManageActor,
  commentId: string,
): Promise<LockedCommentContext> {
  const account = await ports.actor.lockActiveAccount(actor.principalId);
  if (account === null || account.subjectId !== actor.subjectId) {
    throw new CommunityCommentError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
  }
  const probe = await ports.comments.findById(commentId);
  if (probe === null) throw concealed();
  const resolved = await ports.targets.lockResolved(probe.target);
  if (resolved === null || probe.targetGeneration !== resolved.target.generation) {
    throw concealed();
  }
  const record = await ports.comments.lockById(commentId);
  // The row cannot vanish between the probe and the lock: deleting a
  // comment requires this same underlying row lock within the same write.
  if (record === null) throw concealed();
  if (record.targetGeneration !== resolved.target.generation) throw concealed();
  return Object.freeze<LockedCommentContext>({ record, resolved });
}

/**
 * Author edit: the comment must be authored by the actor AND effectively
 * visible (author-deleted and curator-hidden comments are not editable).
 * The If-Match tag must equal the comment's current revision ETag.
 */
export async function editCommunityComment(
  ports: CommunityCommentManagePorts,
  input: CommunityCommentEditInput,
): Promise<CommunityCommentManageResult<CommunityComment>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw invalidRequest('Community comment command input is required.');
  }
  validateManageActor(input.actor);
  const commentId = validateCommentId(input.commentId);
  let body: string;
  try {
    body = parseCommunityCommentEditBody({ body: input.body });
  } catch (error) {
    if (error instanceof CommunityCommentError) throw invalidRequest(error.message);
    throw error;
  }
  const ifMatch = validateIfMatch(input.ifMatch);
  const commandId = validateCommandId(input.commandId);
  const fingerprint = communityCommentEditFingerprint({
    actorPrincipalId: input.actor.principalId, commentId, body,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_COMMENT_EDIT_SCOPE,
    commandId,
  };
  const { record, resolved } = await lockCommentContext(ports, input.actor, commentId);
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  if (record.authorAccountId !== input.actor.principalId) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE);
  }
  if (communityCommentEffectiveState(record) !== 'visible') {
    throw invalidRequest(COMMUNITY_COMMENT_NOT_EDITABLE_MESSAGE);
  }
  const currentEtag = ports.etags.for({ id: record.id, revision: record.revision.toString() });
  if (ifMatch !== currentEtag) throw preconditionFailed(currentEtag);
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalidRequest('The command clock returned invalid time.');
  }
  const updated = await ports.comments.update(
    record.id, record.revision, { body, state: 'visible' }, now,
  );
  if (updated === null) throw preconditionFailed(await freshCommentEtagAfterCasMiss(ports, record, currentEtag));
  await ports.audit.append({
    eventType: 'community.comment_edited',
    principalId: input.actor.principalId,
    details: auditTargetDetails(updated, updated.revision),
    createdAt: now,
  });
  const comment = await projectManagedComment(ports, input.actor, updated, resolved);
  await ports.receipts.complete(binding, fingerprint,
    manageResult(comment, ports.etags.for(comment), `comment:${comment.id}`));
  return { kind: 'succeeded', value: comment };
}

/**
 * Author soft deletion: permanent tombstone (`state:'deleted'`, `body:null`),
 * the reply tree is untouched, and the revision CAS-es forward. The stored
 * row is never physically removed and can never regain a body.
 */
export async function deleteCommunityComment(
  ports: CommunityCommentManagePorts,
  input: CommunityCommentDeleteInput,
): Promise<CommunityCommentManageResult<CommunityComment>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw invalidRequest('Community comment command input is required.');
  }
  validateManageActor(input.actor);
  const commentId = validateCommentId(input.commentId);
  const ifMatch = validateIfMatch(input.ifMatch);
  const commandId = validateCommandId(input.commandId);
  const fingerprint = communityCommentDeleteFingerprint({
    actorPrincipalId: input.actor.principalId, commentId,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_COMMENT_DELETE_SCOPE,
    commandId,
  };
  const { record, resolved } = await lockCommentContext(ports, input.actor, commentId);
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  if (record.authorAccountId !== input.actor.principalId) {
    throw new CommunityCommentError('insufficient_permission', COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE);
  }
  if (record.state === 'deleted') {
    throw invalidRequest(COMMUNITY_COMMENT_NOT_DELETABLE_MESSAGE);
  }
  const currentEtag = ports.etags.for({ id: record.id, revision: record.revision.toString() });
  if (ifMatch !== currentEtag) throw preconditionFailed(currentEtag);
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalidRequest('The command clock returned invalid time.');
  }
  const updated = await ports.comments.update(
    record.id, record.revision, { body: null, state: 'deleted' }, now,
  );
  if (updated === null) throw preconditionFailed(await freshCommentEtagAfterCasMiss(ports, record, currentEtag));
  await ports.audit.append({
    eventType: 'community.comment_deleted',
    principalId: input.actor.principalId,
    details: auditTargetDetails(updated, updated.revision),
    createdAt: now,
  });
  const comment = await projectManagedComment(ports, input.actor, updated, resolved);
  await ports.receipts.complete(binding, fingerprint,
    manageResult(comment, ports.etags.for(comment), `comment:${comment.id}`));
  return { kind: 'succeeded', value: comment };
}

function auditTargetDetails(
  record: CommunityCommentRecord,
  revision: bigint,
): Readonly<Record<string, unknown>> {
  return {
    commentId: record.id,
    targetKind: record.target.kind,
    targetId: record.target.id,
    targetCollectionId: record.target.collectionId,
    targetSeriesId: record.target.seriesId,
    targetGeneration: record.targetGeneration,
    rootId: record.rootId,
    replyToId: record.replyToId,
    depth: record.depth,
    revision: revision.toString(),
  };
}

async function projectManagedComment(
  ports: CommunityCommentManagePorts,
  actor: CommunityCommentManageActor,
  record: CommunityCommentRecord,
  resolved: ResolvedCommunityTarget,
): Promise<CommunityComment> {
  const authors = await ports.authors.publicActors([record.authorAccountId]);
  const viewer: CommunityTargetViewer = {
    accountId: actor.principalId,
    subjectId: actor.subjectId,
  };
  const viewerCurates = await ports.curators.canCurate(
    communityTargetIdentity(resolved.target), actor.subjectId,
  );
  const replyCount = record.depth === 0
    ? (await ports.comments.countVisibleThreadReplies([record.id])).get(record.id) ?? 0
    : record.depth === 1
      ? (await ports.comments.countVisibleDirectReplies([record.id])).get(record.id) ?? 0
      : 0;
  return communityCommentView(record, {
    viewer,
    author: communityCommentAuthorView(record.authorAccountId, authors.get(record.authorAccountId) ?? null),
    replyCount,
    viewerCurates,
  });
}

/**
 * The durable result envelope one CS-04 mutation stores on completion.
 * Exported so the curation/settings commands store identical envelopes.
 */
export function manageResult(
  body: unknown,
  etag: string,
  targetIdentity?: string,
): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      etag,
    },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
  };
}

export function mapManageClaim<Value>(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CommunityCommentManageResult<Value> {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

const mapClaim = mapManageClaim;
