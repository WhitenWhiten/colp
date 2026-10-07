/**
 * CS-05 community reply notifications: the shared write ports and helpers
 * for the two mutations —
 *   markCommunityNotificationsRead (POST /api/v1/me/community-notifications/read)
 *   putCommunityNotificationPreference
 *     (PUT /api/v1/me/community-notification-preferences, in
 *      community-notification-preference.ts).
 *
 * Both follow the community receipt order: request syntax and
 * authentication/object access first (the account lock re-proves the
 * session account is still active), then the durable claim/fingerprint
 * check, then fresh preconditions (the If-Match entity-tag compare for the
 * preference). An exact Known-Command-Id replay returns the saved 200 +
 * representation; a changed fingerprint is 409 command_id_reused.
 *
 * The read command marks only `comment_reply` rows that are still servable
 * (comment exists + target resolves + generation matches); foreign,
 * absent, and concealed ids are ignored — the result reports the ids that
 * actually transitioned (`changedIds`) and the servable `unreadCount`.
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
  COMMUNITY_NOTIFICATION_READ_MAX_IDS,
  CommunityNotificationError,
  isCommunityNotificationOpaqueId,
  type CommunityNotificationPreferenceRecord,
  type CommunityNotificationRow,
  type CommunityReadNotificationsResult,
} from './community-notification.js';
import {
  communityNotificationTargetCacheKey,
  communityNotificationTargetQuery,
  countServableUnread,
  type CommunityNotificationUnreadGroup,
} from './community-notification-inbox.js';
import {
  communityCommentMatchesGeneration,
  type CommunityCommentRecord,
} from './community-comment.js';
import type {
  CommunityTargetQuery,
} from './community-target.js';
import type { ResolvedCommunityTarget } from './community-target-query.js';

export const COMMUNITY_NOTIFICATION_CONTRACT_VERSION = '1.0.0';
export const COMMUNITY_NOTIFICATION_READ_SCOPE = 'community:notification-read:v1';
export const COMMUNITY_NOTIFICATION_PREFERENCE_SCOPE = 'community:notification-preference:v1';

const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/;

export interface CommunityNotificationActor {
  readonly principalId: string;
  readonly subjectId: string;
}

export type CommunityNotificationCommandResult<Value> =
  | { readonly kind: 'succeeded'; readonly value: Value }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

/** Immutable audit event for one CS-05 write (facts only — never content). */
export interface CommunityNotificationAuditEvent {
  readonly eventType:
    | 'community.notification_read'
    | 'community.notification_preference_updated';
  readonly principalId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/** Write ports shared by the read and preference commands. */
export interface CommunityNotificationCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly actor: {
    /** Lock + verify the actor's account row is active; returns subject + creation. */
    lockActiveAccount(accountId: string): Promise<{
      readonly subjectId: string;
      readonly createdAt: Date;
    } | null>;
  };
  readonly preferences: {
    /** Community channel row read (no lock); null until the first PUT. */
    findCommunity(recipientAccountId: string): Promise<CommunityNotificationPreferenceRecord | null>;
    /** Lock the community channel row FOR UPDATE; null until the first PUT. */
    lockCommunity(recipientAccountId: string): Promise<CommunityNotificationPreferenceRecord | null>;
    /** Insert the first community row at revision 2 (the virtual tag was '1'). */
    insertCommunity(
      recipientAccountId: string,
      write: { readonly enabled: boolean; readonly revision: bigint; readonly updatedAt: Date },
    ): Promise<CommunityNotificationPreferenceRecord>;
    /** CAS update fenced on the compared revision; null on the miss. */
    updateCommunity(
      recipientAccountId: string,
      enabled: boolean,
      expectedRevision: bigint,
      updatedAt: Date,
    ): Promise<CommunityNotificationPreferenceRecord | null>;
  };
  readonly notifications: {
    /** Lock `comment_reply` rows of one recipient FOR UPDATE in id order. */
    lockForRead(
      recipientAccountId: string,
      notificationIds: readonly string[],
    ): Promise<readonly CommunityNotificationRow[]>;
    /**
     * Transition unread rows to read (sets `read_at`, tightens the
     * 90-day read retention cap, increments `state_revision`). Returns the
     * ids that actually transitioned.
     */
    markRead(
      recipientAccountId: string,
      notificationIds: readonly string[],
      readAt: Date,
    ): Promise<readonly string[]>;
    /** Unread rows grouped by pinned target (same shape as the query port). */
    unreadGroups(recipientAccountId: string): Promise<readonly CommunityNotificationUnreadGroup[]>;
  };
  readonly comments: {
    findMany(commentIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentRecord>>;
  };
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
  };
  /** Strong opaque ETag derivation (injected; the key stays in composition). */
  readonly etags: {
    preference(input: { readonly recipientAccountId: string; readonly revision: string }): string;
  };
  readonly audit: { append(event: CommunityNotificationAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}

export function communityNotificationInvalidRequest(message: string): CommunityNotificationError {
  return new CommunityNotificationError('invalid_request', message);
}

export function communityNotificationConcealed(): CommunityNotificationError {
  return new CommunityNotificationError(
    'resource_not_found', 'The community notification inbox was not found.');
}

export function communityNotificationPreconditionFailed(
  message: string,
  currentEtag: string,
): CommunityNotificationError {
  return new CommunityNotificationError('precondition_failed', message, { currentEtag });
}

export function validateCommunityNotificationActor(actor: CommunityNotificationActor): void {
  for (const identity of [actor.principalId, actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw communityNotificationInvalidRequest('Community notification actor identities are invalid.');
    }
  }
}

export function validateCommunityNotificationIfMatch(value: unknown): string {
  if (typeof value !== 'string' || !STRONG_ENTITY_TAG.test(value)) {
    throw communityNotificationInvalidRequest('If-Match must be a single strong entity-tag.');
  }
  return value;
}

export function validateCommunityNotificationCommandId(value: string): string {
  try {
    return assertCanonicalCommandId(value);
  } catch {
    throw communityNotificationInvalidRequest('commandId must be a canonical UUID v4.');
  }
}

export function mapCommunityNotificationClaim<Value>(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): CommunityNotificationCommandResult<Value> {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

/** The durable result envelope one CS-05 mutation stores on completion. */
export function communityNotificationResult(
  body: unknown,
  etag: string | null,
): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      ...(etag === null ? {} : { etag }),
    },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_NOTIFICATION_CONTRACT_VERSION,
  };
}

/**
 * Parse the closed ReadNotifications request `{ids}`. `ids` is a unique
 * array of 1..100 opaque notification ids; unknown keys reject and null
 * is never equivalent to missing.
 */
export function parseCommunityNotificationReadBody(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw communityNotificationInvalidRequest('The community notification read body is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'ids') {
    throw communityNotificationInvalidRequest('The community notification read body is invalid.');
  }
  return validateCommunityNotificationIds(record.ids);
}

/** Validate the `ids` array — unique opaque ids, 1..100. */
export function validateCommunityNotificationIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1
      || value.length > COMMUNITY_NOTIFICATION_READ_MAX_IDS) {
    throw communityNotificationInvalidRequest('The community notification ids are invalid.');
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (!isCommunityNotificationOpaqueId(id) || seen.has(id)) {
      throw communityNotificationInvalidRequest('The community notification ids are invalid.');
    }
    seen.add(id);
  }
  return Object.freeze([...seen]);
}

export function communityNotificationReadFingerprint(input: {
  readonly actorPrincipalId: string;
  readonly ids: readonly string[];
}): string {
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: input.actorPrincipalId,
    ids: input.ids,
    contractVersion: COMMUNITY_NOTIFICATION_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export interface CommunityNotificationReadInput {
  readonly actor: CommunityNotificationActor;
  readonly ids: unknown;
  readonly commandId: string;
}

/**
 * Bulk mark-read. Only servable `comment_reply` rows owned by the
 * recipient transition; foreign/absent/concealed ids are ignored. The
 * community preference disables the representation: while disabled the
 * command succeeds with `changedIds: []` and `unreadCount: 0` (the rows
 * stay durable — re-enabling restores them).
 */
export async function markCommunityNotificationsRead(
  ports: CommunityNotificationCommandPorts,
  input: CommunityNotificationReadInput,
): Promise<CommunityNotificationCommandResult<CommunityReadNotificationsResult>> {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw communityNotificationInvalidRequest('Community notification command input is required.');
  }
  validateCommunityNotificationActor(input.actor);
  const ids = validateCommunityNotificationIds(input.ids);
  const commandId = validateCommunityNotificationCommandId(input.commandId);
  const fingerprint = communityNotificationReadFingerprint({
    actorPrincipalId: input.actor.principalId, ids,
  });
  const binding = {
    principalId: input.actor.principalId,
    commandScope: COMMUNITY_NOTIFICATION_READ_SCOPE,
    commandId,
  };
  const account = await ports.actor.lockActiveAccount(input.actor.principalId);
  if (account === null || account.subjectId !== input.actor.subjectId) {
    throw communityNotificationConcealed();
  }
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapCommunityNotificationClaim(claim);
  const preference = await ports.preferences.findCommunity(input.actor.principalId);
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw communityNotificationInvalidRequest('The command clock returned invalid time.');
  }
  if (preference !== null && !preference.enabled) {
    const disabled: CommunityReadNotificationsResult = Object.freeze({
      changedIds: Object.freeze([]),
      unreadCount: 0,
    });
    await ports.audit.append({
      eventType: 'community.notification_read',
      principalId: input.actor.principalId,
      details: { requestedCount: ids.length, changedCount: 0, unreadCount: 0 },
      createdAt: now,
    });
    await ports.receipts.complete(binding, fingerprint,
      communityNotificationResult(disabled, null));
    return { kind: 'succeeded', value: disabled };
  }
  const rows = await ports.notifications.lockForRead(input.actor.principalId, ids);
  const records = rows.length === 0
    ? new Map<string, CommunityCommentRecord>()
    : await ports.comments.findMany(rows.map((row) => row.subjectId));
  const resolvedByKey = new Map<string, ResolvedCommunityTarget | null>();
  for (const row of rows) {
    const record = records.get(row.subjectId);
    if (record === undefined) continue;
    const key = communityNotificationTargetCacheKey(record.target);
    if (!resolvedByKey.has(key)) {
      resolvedByKey.set(key, await ports.targets.resolve(
        communityNotificationTargetQuery(record.target),
      ));
    }
  }
  const servableIds = rows
    .filter((row) => {
      const record = records.get(row.subjectId);
      if (record === undefined) return false;
      const resolved = resolvedByKey.get(communityNotificationTargetCacheKey(record.target)) ?? null;
      return resolved !== null && communityCommentMatchesGeneration(record, resolved.target.generation);
    })
    .map((row) => row.notificationId);
  const transitioned = servableIds.length === 0
    ? []
    : await ports.notifications.markRead(input.actor.principalId, servableIds, now);
  const transitionedSet = new Set(transitioned);
  const changedIds = Object.freeze(ids.filter((id) => transitionedSet.has(id)));
  const unreadCount = await countServableUnread(
    ports, input.actor.principalId, resolvedByKey,
  );
  const result: CommunityReadNotificationsResult = Object.freeze({ changedIds, unreadCount });
  await ports.audit.append({
    eventType: 'community.notification_read',
    principalId: input.actor.principalId,
    details: {
      requestedCount: ids.length,
      changedCount: changedIds.length,
      unreadCount,
    },
    createdAt: now,
  });
  await ports.receipts.complete(binding, fingerprint,
    communityNotificationResult(result, null));
  return { kind: 'succeeded', value: result };
}
