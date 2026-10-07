/**
 * CS-05 community reply notifications: the closed wire shapes plus the
 * shared recipient/preference/preview rules for the durable
 * `comment_reply` notification kind.
 *
 * Every row is a fact of the shared notification authority
 * (`notifications` + `notification_preferences` + `notification_deliveries`
 * — in-app only, no delivery channel). The notification binds the REPLY
 * comment (`subject_type='community_comment'`, `subject_id=comment_id`)
 * and the replying actor (`actor_profile_id`). It is produced only by the
 * durable `community.comment-created` outbox event consumed by the
 * `community_comment_notification` projection route — never by a
 * process-local queue.
 *
 * Recipients are computed once at comment-create time inside the comment
 * transaction: the target owner plus the parent comment author, minus the
 * replying actor, deduplicated. The worker re-proves the recipient is
 * still justified (still the parent author — immutable — or still the
 * target owner) before delivering.
 *
 * The community preference is the `notification_preferences` row for
 * channel 'community'; an absent row is the virtual enabled default whose
 * `revision`/`updatedAt` come from the recipient account creation stamp.
 * Delivery ALSO respects the in_app channel preference (the shared in-app
 * delivery gate); reads gate on the community channel only.
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import {
  communityCommentEffectiveState,
  type CommunityCommentAuthor,
  type CommunityCommentRecord,
} from './community-comment.js';
import type { CommunityTarget } from './community-target.js';
import type { ResolvedCommunityTarget } from './community-target-query.js';

export const COMMUNITY_NOTIFICATION_KIND = 'comment_reply' as const;
export const COMMUNITY_NOTIFICATION_SUBJECT_TYPE = 'community_comment' as const;
export const COMMUNITY_NOTIFICATION_CHANNEL = 'community' as const;
export const COMMUNITY_NOTIFICATION_READ_MAX_IDS = 100;
export const COMMUNITY_NOTIFICATION_INBOX_MAX_LIMIT = 100;
export const COMMUNITY_NOTIFICATION_INBOX_DEFAULT_LIMIT = 20;
export const COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS = 200;

export type CommunityNotificationErrorCode =
  | 'invalid_request'
  | 'invalid_query'
  | 'invalid_cursor'
  | 'resource_not_found'
  | 'precondition_failed';

export class CommunityNotificationError extends Error {
  /** Current entity-tag a 412 caller should refresh against, when known. */
  readonly currentEtag: string | null;
  constructor(
    readonly code: CommunityNotificationErrorCode,
    message: string,
    options: { readonly currentEtag?: string | null } = {},
  ) {
    super(message);
    this.name = 'CommunityNotificationError';
    this.currentEtag = options.currentEtag ?? null;
  }
}

export const COMMUNITY_NOTIFICATION_CONCEALED_MESSAGE =
  'The community notification was not found.';
export const COMMUNITY_NOTIFICATION_PREFERENCE_PRECONDITION_MESSAGE =
  'The community notification preference changed; fetch it again and retry with its current ETag.';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

/** Notification/comment id validation — malformed ids are a 400, not an oracle. */
export function isCommunityNotificationOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

/** Exact closed CommunityNotification object served by the inbox. */
export interface CommunityNotification {
  readonly id: string;
  readonly kind: typeof COMMUNITY_NOTIFICATION_KIND;
  readonly commentId: string;
  readonly target: CommunityTarget;
  readonly actor: CommunityCommentAuthor;
  readonly preview: string | null;
  readonly href: string;
  readonly read: boolean;
  readonly createdAt: string;
}

/** Exact closed CommunityInbox object returned by listCommunityNotifications. */
export interface CommunityInbox {
  readonly items: readonly CommunityNotification[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

/** Exact closed CommunityNotificationPreference object (GET/PUT body). */
export interface CommunityNotificationPreference {
  readonly enabled: boolean;
  readonly revision: string;
  readonly updatedAt: string;
}

/** Durable `notification_preferences` row for the community channel. */
export interface CommunityNotificationPreferenceRecord {
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

/**
 * The revision of the virtual (never-written) community preference
 * representation. Per the contract's virtual-default rule the virtual
 * representation is revision '1' with `updatedAt` = the recipient account
 * creation stamp; the first successful CAS stores revision 2.
 */
export const COMMUNITY_NOTIFICATION_PREFERENCE_VIRTUAL_REVISION = '1';
/** First stored `state_revision` written by putCommunityNotificationPreference. */
export const COMMUNITY_NOTIFICATION_PREFERENCE_FIRST_REVISION = 2n;

/**
 * Durable notification row consumed by the community inbox/read adapters.
 * `subjectId` is the reply comment id; `actorProfileId` is the replying
 * account (the 'community_comment' shape CHECK requires it non-null).
 */
export interface CommunityNotificationRow {
  readonly notificationId: string;
  readonly actorProfileId: string | null;
  readonly subjectId: string;
  readonly state: 'unread' | 'read';
  readonly readAt: Date | null;
  readonly occurredAt: Date;
}

/** Keyset position after a row in the inbox's `occurred_at DESC, id DESC` order. */
export interface CommunityNotificationKeysetPosition {
  readonly occurredAt: Date;
  readonly notificationId: string;
}

/**
 * Compute the durable recipients for one new comment: the target owner plus
 * the parent comment author, minus the replying actor, deduplicated and
 * sorted for deterministic producer order. `ownerAccountId`/`parentAuthor
 * AccountId` are null when the account is gone or the comment is a root.
 */
export function communityReplyNotificationRecipients(input: {
  readonly actorAccountId: string;
  readonly ownerAccountId: string | null;
  readonly parentAuthorAccountId: string | null;
}): readonly string[] {
  const recipients = new Set<string>();
  if (input.ownerAccountId !== null && input.ownerAccountId !== input.actorAccountId) {
    recipients.add(input.ownerAccountId);
  }
  if (input.parentAuthorAccountId !== null
      && input.parentAuthorAccountId !== input.actorAccountId) {
    recipients.add(input.parentAuthorAccountId);
  }
  return Object.freeze([...recipients].sort());
}

/**
 * The reply excerpt served as `preview`: the first
 * COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS code points of the stored
 * body while the comment is effectively visible; `null` once the comment
 * is author-deleted or curator-hidden (the row keeps its position — the
 * preview is the only part that is redacted).
 */
export function communityNotificationPreview(
  record: Pick<CommunityCommentRecord, 'body' | 'state' | 'curationHidden'>,
): string | null {
  if (communityCommentEffectiveState(record) !== 'visible' || record.body === null) return null;
  return [...record.body].slice(0, COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS).join('');
}

/** Deep link to the reply inside its comment thread (`uri-reference`). */
export function communityNotificationHref(
  resolved: Pick<ResolvedCommunityTarget, 'href'>,
  commentId: string,
): string {
  return `${resolved.href}#comment-${commentId}`;
}

/** Project a durable row + comment + resolved target into the wire object. */
export function communityNotificationView(
  row: CommunityNotificationRow,
  record: CommunityCommentRecord,
  resolved: ResolvedCommunityTarget,
  actor: CommunityCommentAuthor,
): CommunityNotification {
  return Object.freeze<CommunityNotification>({
    id: row.notificationId,
    kind: COMMUNITY_NOTIFICATION_KIND,
    commentId: record.id,
    target: resolved.target,
    actor,
    preview: communityNotificationPreview(record),
    href: communityNotificationHref(resolved, record.id),
    read: row.state === 'read',
    createdAt: row.occurredAt.toISOString(),
  });
}

/** Exact closed ReadNotificationsResult returned by the read command. */
export interface CommunityReadNotificationsResult {
  readonly changedIds: readonly string[];
  readonly unreadCount: number;
}

/** The virtual preference served before any community row exists. */
export function communityNotificationPreferenceVirtual(
  accountCreatedAt: Date,
): CommunityNotificationPreference {
  return Object.freeze<CommunityNotificationPreference>({
    enabled: true,
    revision: COMMUNITY_NOTIFICATION_PREFERENCE_VIRTUAL_REVISION,
    updatedAt: accountCreatedAt.toISOString(),
  });
}

/** Project a durable community preference row into the wire object. */
export function communityNotificationPreferenceView(
  record: CommunityNotificationPreferenceRecord,
): CommunityNotificationPreference {
  return Object.freeze<CommunityNotificationPreference>({
    enabled: record.enabled,
    revision: record.revision.toString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/**
 * Strong opaque ETag for the community preference. The configured community
 * HMAC key binds the tag to (recipient account, revision) so a client can
 * only echo it back — If-Match compares it verbatim against the fresh
 * authority (the virtual tag before the first write).
 */
export function communityNotificationPreferenceEtag(input: {
  readonly recipientAccountId: string;
  readonly revision: string;
}, hmacKey: Buffer): string {
  if (!(hmacKey instanceof Buffer) || hmacKey.length < 16) {
    throw new TypeError('community notification preference ETag requires a configured HMAC key');
  }
  const digest = createHmac('sha256', hmacKey)
    .update(canonicalJson({
      communityNotificationPreference: {
        recipientAccountId: input.recipientAccountId,
        revision: input.revision,
      },
    }), 'utf8')
    .digest('base64url');
  return `"community-notification-preference:${digest.slice(0, 32)}"`;
}
