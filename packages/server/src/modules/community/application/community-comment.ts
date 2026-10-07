/**
 * CS-03 community comments and replies: the durable Comment wire shape plus
 * closed-body parsing and text normalization.
 *
 * A comment binds the closed Target identity AND the generation it was
 * written against. Root comments have depth 0 with `rootId === id` and
 * `replyToId === null`; direct replies have depth 1; nested replies have
 * depth 2. Depth 3 is structurally impossible and rejected as
 * invalid_request before any row exists.
 *
 * User-facing text is trimmed and NFC-normalized, then measured in Unicode
 * code points (1..4000). Empty/whitespace-only bodies reject; there is no
 * silent truncation. Bodies are plain text — the wire shape carries no
 * markup interpretation.
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import {
  COMMUNITY_BOOKMARK_GENERATION_PREFIX,
  COMMUNITY_STATIC_GENERATION,
  CommunityTargetError,
  parseCommunityTarget,
  type CommunityTarget,
  type CommunityTargetIdentity,
} from './community-target.js';
import type { CommunityTargetViewer } from './community-target-query.js';

export const COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS = 4_000;
export const COMMUNITY_COMMENT_REASON_MAX_CODE_POINTS = 1_000;
export const COMMUNITY_COMMENT_MAX_DEPTH = 2;
export const COMMUNITY_COMMENT_STATES = Object.freeze(['visible', 'deleted', 'hidden'] as const);
export type CommunityCommentState = (typeof COMMUNITY_COMMENT_STATES)[number];

export type CommunityCommentErrorCode =
  | 'invalid_request'
  | 'invalid_query'
  | 'invalid_cursor'
  | 'resource_not_found'
  | 'insufficient_permission'
  | 'precondition_failed'
  | 'revision_conflict';

export class CommunityCommentError extends Error {
  /** Current entity-tag a 412 caller should refresh against, when known. */
  readonly currentEtag: string | null;
  constructor(
    readonly code: CommunityCommentErrorCode,
    message: string,
    options: { readonly currentEtag?: string | null } = {},
  ) {
    super(message);
    this.name = 'CommunityCommentError';
    this.currentEtag = options.currentEtag ?? null;
  }
}

/** Public projection of the comment author (PublicActor). */
export interface CommunityCommentAuthor {
  readonly id: string;
  readonly handle: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/** Display name served for a comment author whose account is gone. */
export const COMMUNITY_COMMENT_FORMER_MEMBER_DISPLAY_NAME = 'Former member';
/** Fallback display name for a live account with neither name nor handle. */
export const COMMUNITY_COMMENT_MEMBER_DISPLAY_NAME = 'Member';

/**
 * The safe PublicActor for one stored `author_account_id`. A live account
 * serves its current canonical handle/display name/sanitized avatar; a
 * missing, disabled, or deleted account serves the fixed tombstone so no
 * historical private identity leaks through an old comment.
 */
export function communityCommentAuthorView(
  accountId: string,
  live: { readonly handle: string | null; readonly displayName: string; readonly avatarUrl: string | null } | null,
): CommunityCommentAuthor {
  if (live === null) {
    return Object.freeze<CommunityCommentAuthor>({
      id: accountId,
      handle: null,
      displayName: COMMUNITY_COMMENT_FORMER_MEMBER_DISPLAY_NAME,
      avatarUrl: null,
    });
  }
  const displayName = live.displayName.trim().length > 0
    ? live.displayName
    : live.handle ?? COMMUNITY_COMMENT_MEMBER_DISPLAY_NAME;
  return Object.freeze<CommunityCommentAuthor>({
    id: accountId,
    handle: live.handle,
    displayName,
    avatarUrl: live.avatarUrl,
  });
}

/** Exact closed Comment object returned by the four CS-03 operations. */
export interface CommunityComment {
  readonly id: string;
  readonly target: CommunityTarget;
  readonly rootId: string;
  readonly replyToId: string | null;
  readonly depth: number;
  readonly author: CommunityCommentAuthor;
  readonly body: string | null;
  readonly state: CommunityCommentState;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replyCount: number;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canCurate: boolean;
}

/** Durable row view consumed by the application services. */
export interface CommunityCommentRecord {
  readonly id: string;
  readonly target: CommunityTargetIdentity;
  readonly targetGeneration: string;
  readonly rootId: string;
  readonly replyToId: string | null;
  readonly depth: number;
  readonly authorAccountId: string;
  readonly body: string | null;
  readonly state: CommunityCommentState;
  /** CS-04: whether the curation overlay currently hides this comment. */
  readonly curationHidden: boolean;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The normalized create payload after closed-object validation. */
export interface CommunityCommentCreateInput {
  readonly target: CommunityTarget;
  readonly body: string;
  readonly replyToId: string | null;
}

export const COMMUNITY_COMMENT_CONCEALED_MESSAGE = 'The community comment was not found.';
export const COMMUNITY_COMMENT_TARGET_STALE_MESSAGE =
  'The community target changed; resolve it again before commenting.';
export const COMMUNITY_COMMENT_DEPTH_MESSAGE =
  'Replies may nest at most two levels below the root comment.';
export const COMMUNITY_REPLY_TARGET_MISMATCH_MESSAGE =
  'A reply must reference a comment on the same target and thread.';
export const COMMUNITY_COMMENT_PRECONDITION_MESSAGE =
  'The comment changed; fetch it again and retry with its current ETag.';
export const COMMUNITY_COMMENT_LOCKED_MESSAGE =
  'Comments are locked for this target.';
export const COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE =
  'Only the comment author may change this comment.';
export const COMMUNITY_COMMENT_NOT_EDITABLE_MESSAGE =
  'A deleted or hidden comment cannot be edited.';
export const COMMUNITY_COMMENT_NOT_DELETABLE_MESSAGE =
  'A deleted comment cannot be deleted again.';
export const COMMUNITY_CURATION_PRECONDITION_MESSAGE =
  'The comment curation changed; fetch it again and retry with its current ETag.';
export const COMMUNITY_SETTINGS_PRECONDITION_MESSAGE =
  'The comment settings changed; fetch them again and retry with their current ETag.';
export const COMMUNITY_CURATION_FORBIDDEN_MESSAGE =
  'Only a target owner or editor may curate comments.';
export const COMMUNITY_SETTINGS_FORBIDDEN_MESSAGE =
  'Only a target owner or editor may change comment settings.';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const CREATE_BODY_KEYS = ['body', 'replyToId', 'target'] as const;
const EDIT_BODY_KEYS = ['body'] as const;

function invalidRequest(message: string): CommunityCommentError {
  return new CommunityCommentError('invalid_request', message);
}

export function isCommunityOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

/** Path/body comment id validation: malformed ids are a 400, not an oracle. */
export function parseCommunityCommentId(value: unknown): string {
  if (!isCommunityOpaqueId(value)) {
    throw invalidRequest('The community comment id is invalid.');
  }
  return value;
}

/**
 * Trim + NFC body normalization. The length bound is measured in Unicode
 * code points AFTER normalization so a 4000-scalar body is never rejected
 * by UTF-16 units and decomposed input cannot bypass the bound.
 */
export function normalizeCommunityCommentBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('The community comment body must be a string.');
  }
  const normalized = value.trim().normalize('NFC');
  const codePoints = [...normalized].length;
  if (codePoints < 1 || codePoints > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS) {
    throw invalidRequest(
      `The community comment body must be 1..${COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS} characters.`,
    );
  }
  return normalized;
}

/**
 * Parse the closed CreateComment object {target, body, replyToId}. Unknown
 * keys reject, null is never equivalent to missing, and the target reuses
 * the CS-01 closed-object parser (generation syntax included).
 */
export function parseCommunityCommentCreateBody(value: unknown): CommunityCommentCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('The community comment body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CREATE_BODY_KEYS.length
      || CREATE_BODY_KEYS.some((key) => !keys.includes(key))) {
    throw invalidRequest('The community comment body is invalid.');
  }
  let target: CommunityTarget;
  try {
    target = parseCommunityTarget(record.target);
  } catch (error) {
    if (error instanceof CommunityTargetError) throw invalidRequest(error.message);
    throw error;
  }
  const body = normalizeCommunityCommentBody(record.body);
  const replyToId = record.replyToId;
  if (replyToId === null) {
    return Object.freeze<CommunityCommentCreateInput>({ target, body, replyToId: null });
  }
  if (!isCommunityOpaqueId(replyToId)) {
    throw invalidRequest('The community comment replyToId is invalid.');
  }
  return Object.freeze<CommunityCommentCreateInput>({ target, body, replyToId });
}

/**
 * Parse the closed EditComment object {body}. Unknown keys reject and the
 * body reuses the same trim + NFC + code-point bounds as creation; a
 * whitespace-only or null body is a 400, never a silent delete.
 */
export function parseCommunityCommentEditBody(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('The community comment body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== EDIT_BODY_KEYS.length
      || EDIT_BODY_KEYS.some((key) => !keys.includes(key))) {
    throw invalidRequest('The community comment body is invalid.');
  }
  return normalizeCommunityCommentBody(record.body);
}

/**
 * Trim + NFC normalization for curator reasons (curation hide/unhide and
 * comment-area lock/unlock). The 1..1000 code-point bound is measured after
 * normalization; the reason is required and never silently dropped.
 */
export function normalizeCommunityReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('The community moderation reason must be a string.');
  }
  const normalized = value.trim().normalize('NFC');
  const codePoints = [...normalized].length;
  if (codePoints < 1 || codePoints > COMMUNITY_COMMENT_REASON_MAX_CODE_POINTS) {
    throw invalidRequest(
      `The community moderation reason must be 1..${COMMUNITY_COMMENT_REASON_MAX_CODE_POINTS} characters.`,
    );
  }
  return normalized;
}

/** The client-facing state: author deletion dominates; the curator overlay hides visible rows. */
export function communityCommentEffectiveState(
  record: Pick<CommunityCommentRecord, 'state' | 'curationHidden'>,
): CommunityCommentState {
  if (record.state === 'deleted') return 'deleted';
  return record.state === 'hidden' || record.curationHidden ? 'hidden' : 'visible';
}

/**
 * Whether a stored comment row belongs to the currently resolved target
 * generation. A comment written against a superseded bookmark generation is
 * concealed with the content it described.
 */
export function communityCommentMatchesGeneration(
  record: Pick<CommunityCommentRecord, 'targetGeneration'>,
  resolvedGeneration: string,
): boolean {
  return record.targetGeneration === resolvedGeneration;
}

/**
 * Strong opaque ETag for a Comment. The configured community HMAC key binds
 * the tag to (comment id, revision) so a client can only echo it back —
 * CS-04 If-Match compares it verbatim against a fresh projection.
 */
export function communityCommentEtag(
  comment: Pick<CommunityComment, 'id' | 'revision'>,
  hmacKey: Buffer,
): string {
  if (!(hmacKey instanceof Buffer) || hmacKey.length < 16) {
    throw new TypeError('community comment ETag requires a configured HMAC key');
  }
  const digest = createHmac('sha256', hmacKey)
    .update(canonicalJson({ communityComment: { id: comment.id, revision: comment.revision } }), 'utf8')
    .digest('base64url');
  return `"community-comment:${digest.slice(0, 32)}"`;
}

/**
 * Rebuild the closed Target wire object a stored row was written against:
 * the row's identity columns plus its pinned generation. Per-kind parent
 * rules are enforced by the table CHECK, so the non-null parents are sound.
 */
export function communityCommentTarget(
  record: Pick<CommunityCommentRecord, 'target' | 'targetGeneration'>,
): CommunityTarget {
  const identity = record.target;
  const generation = record.targetGeneration;
  switch (identity.kind) {
    case 'bookmark':
      if (!generation.startsWith(COMMUNITY_BOOKMARK_GENERATION_PREFIX)) {
        throw new Error('community comment target generation is inconsistent');
      }
      return {
        kind: 'bookmark', id: identity.id, collectionId: identity.collectionId!,
        seriesId: null, generation,
      };
    case 'digest_edition':
      if (generation !== COMMUNITY_STATIC_GENERATION) {
        throw new Error('community comment target generation is inconsistent');
      }
      return {
        kind: 'digest_edition', id: identity.id, collectionId: null,
        seriesId: identity.seriesId!, generation,
      };
    case 'digest_series':
      if (generation !== COMMUNITY_STATIC_GENERATION) {
        throw new Error('community comment target generation is inconsistent');
      }
      return {
        kind: 'digest_series', id: identity.id, collectionId: null,
        seriesId: null, generation,
      };
    default:
      if (generation !== COMMUNITY_STATIC_GENERATION) {
        throw new Error('community comment target generation is inconsistent');
      }
      return {
        kind: 'collection', id: identity.id, collectionId: null,
        seriesId: null, generation,
      };
  }
}

/**
 * Project a stored record into the exact closed Comment object. `body` is
 * the stored text only when the effective state is `visible`; author
 * deletion and the CS-04 curator overlay both serve `body: null` tombstones
 * (`state` reports `deleted`/`hidden` respectively). The author projection
 * is the caller-supplied public actor (current safe identity or tombstone).
 * `canEdit`/`canDelete` are the author hints — a hidden comment is not
 * editable but remains author-deletable — and `canCurate` is the
 * caller-computed target owner/editor hint; all false anonymously.
 */
export function communityCommentView(
  record: CommunityCommentRecord,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly author: CommunityCommentAuthor;
    readonly replyCount: number;
    readonly viewerCurates: boolean;
  },
): CommunityComment {
  const authenticated = input.viewer.accountId !== null && input.viewer.subjectId !== null;
  const authored = authenticated && input.viewer.accountId === record.authorAccountId;
  const target = communityCommentTarget(record);
  const state = communityCommentEffectiveState(record);
  return Object.freeze<CommunityComment>({
    id: record.id,
    target,
    rootId: record.rootId,
    replyToId: record.replyToId,
    depth: record.depth,
    author: input.author,
    body: state === 'visible' ? record.body : null,
    state,
    revision: record.revision.toString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    replyCount: input.replyCount,
    canEdit: authored && state === 'visible',
    canDelete: authored && record.state !== 'deleted',
    canCurate: authenticated && input.viewerCurates,
  });
}

/* ------------------------------------------------------------------ */
/* CS-04: curation overlay + comment-area settings wire shapes.          */
/* ------------------------------------------------------------------ */

/**
 * Durable `community_comment_curations` row — the singleton curator overlay
 * for one comment. Its `revision` is the independent curation ETag
 * authority; it never shares ordering with `community_comments.revision`.
 */
export interface CommunityCommentCurationRecord {
  readonly commentId: string;
  readonly hidden: boolean;
  readonly reason: string;
  readonly revision: bigint;
  readonly updatedByAccountId: string;
  readonly updatedAt: Date;
}

/** Exact closed Curation object returned by getCommentCuration/setCommentCuration. */
export interface CommunityCuration {
  readonly commentId: string;
  readonly hidden: boolean;
  readonly reason: string | null;
  readonly revision: string;
  readonly updatedAt: string;
}

/**
 * The revision of the virtual (never-written) curation representation. Per
 * the contract's virtual-default rule it is '1' — the first successful CAS
 * write stores revision 2, so a client that compared the virtual ETag loses
 * the race against the first real write — never a silent lost update.
 */
export const COMMUNITY_CURATION_VIRTUAL_REVISION = '1';

/**
 * Project a curation row into the closed Curation object. `reason` is
 * exposed only while the overlay hides the comment; the stored value keeps
 * the last curator write reason for audit.
 */
export function communityCurationView(
  record: CommunityCommentCurationRecord,
): CommunityCuration {
  return Object.freeze<CommunityCuration>({
    commentId: record.commentId,
    hidden: record.hidden,
    reason: record.hidden ? record.reason : null,
    revision: record.revision.toString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** The virtual Curation served before any curator write exists for the comment. */
export function communityCurationVirtual(
  commentId: string,
  commentCreatedAt: Date,
): CommunityCuration {
  return Object.freeze<CommunityCuration>({
    commentId,
    hidden: false,
    reason: null,
    revision: COMMUNITY_CURATION_VIRTUAL_REVISION,
    updatedAt: commentCreatedAt.toISOString(),
  });
}

/**
 * Strong opaque ETag for a Curation. The configured community HMAC key
 * binds the tag to (comment id, curation revision) — a third authority
 * distinct from the comment and settings tags.
 */
export function communityCurationEtag(
  curation: Pick<CommunityCuration, 'commentId' | 'revision'>,
  hmacKey: Buffer,
): string {
  if (!(hmacKey instanceof Buffer) || hmacKey.length < 16) {
    throw new TypeError('community curation ETag requires a configured HMAC key');
  }
  const digest = createHmac('sha256', hmacKey)
    .update(canonicalJson({ communityCuration: { id: curation.commentId, revision: curation.revision } }), 'utf8')
    .digest('base64url');
  return `"community-curation:${digest.slice(0, 32)}"`;
}

/**
 * Durable `community_comment_settings` row — the singleton comment-area
 * settings for one target identity (generation-independent). Its `revision`
 * is the independent settings ETag authority.
 */
export interface CommunityCommentSettingsRecord {
  readonly target: CommunityTargetIdentity;
  readonly locked: boolean;
  readonly reason: string | null;
  readonly revision: bigint;
  readonly updatedByAccountId: string;
  readonly updatedAt: Date;
}

/** Exact closed CommentSettings object returned by the settings operations. */
export interface CommunityCommentSettings {
  readonly target: CommunityTarget;
  readonly locked: boolean;
  readonly reason: string | null;
  readonly revision: string;
  readonly updatedAt: string;
}

/**
 * The revision of the virtual (never-written) settings representation. Per
 * the contract's virtual-default rule it is '1'; the first successful CAS
 * write stores revision 2.
 */
export const COMMUNITY_SETTINGS_VIRTUAL_REVISION = '1';

/**
 * Project a settings row into the closed CommentSettings object against the
 * RESOLVED current target (the stored row is generation-independent, so the
 * wire echoes the resolved generation). `reason` is exposed only while the
 * area is locked.
 */
export function communityCommentSettingsView(
  record: CommunityCommentSettingsRecord,
  resolved: CommunityTarget,
): CommunityCommentSettings {
  return Object.freeze<CommunityCommentSettings>({
    target: resolved,
    locked: record.locked,
    reason: record.locked ? record.reason : null,
    revision: record.revision.toString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** The virtual CommentSettings served before any curator write exists for the target. */
export function communityCommentSettingsVirtual(
  resolved: CommunityTarget,
  targetCreatedAt: Date,
): CommunityCommentSettings {
  return Object.freeze<CommunityCommentSettings>({
    target: resolved,
    locked: false,
    reason: null,
    revision: COMMUNITY_SETTINGS_VIRTUAL_REVISION,
    updatedAt: targetCreatedAt.toISOString(),
  });
}

/**
 * Strong opaque ETag for CommentSettings, bound to the full target identity
 * plus the settings revision — a fourth authority distinct from comment and
 * curation tags.
 */
export function communityCommentSettingsEtag(
  settings: Pick<CommunityCommentSettings, 'target' | 'revision'>,
  hmacKey: Buffer,
): string {
  if (!(hmacKey instanceof Buffer) || hmacKey.length < 16) {
    throw new TypeError('community comment settings ETag requires a configured HMAC key');
  }
  const target = settings.target;
  const digest = createHmac('sha256', hmacKey)
    .update(canonicalJson({
      communityCommentSettings: {
        kind: target.kind,
        id: target.id,
        collectionId: target.collectionId,
        seriesId: target.seriesId,
        revision: settings.revision,
      },
    }), 'utf8')
    .digest('base64url');
  return `"community-comment-settings:${digest.slice(0, 32)}"`;
}
