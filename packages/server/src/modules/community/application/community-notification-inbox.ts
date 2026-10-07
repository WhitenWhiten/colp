/**
 * CS-05 community reply notifications: listCommunityNotifications
 * (GET /api/v1/me/community-notifications) and
 * getCommunityNotificationPreference
 * (GET /api/v1/me/community-notification-preferences).
 *
 * The inbox pages `comment_reply` rows of the shared notification
 * authority in `occurredAt DESC, id DESC` order behind the opaque cursor.
 * A row is SERVED only while the reply comment still exists, its target
 * still resolves, and the generation it was written against is still the
 * target's current generation — every other outcome conceals the row
 * (tombstoned comments stay served with `preview:null`; only the excerpt
 * is redacted). `unreadCount` counts only servable unread rows: it is
 * grouped per target so concealed generations never inflate it.
 *
 * Reads gate on the community preference (`notification_preferences`
 * channel 'community'): disabled serves an empty inbox and zero unread.
 * The virtual default (no row) is enabled.
 */
import {
  COMMUNITY_NOTIFICATION_INBOX_DEFAULT_LIMIT,
  COMMUNITY_NOTIFICATION_INBOX_MAX_LIMIT,
  CommunityNotificationError,
  communityNotificationPreferenceView,
  communityNotificationPreferenceVirtual,
  communityNotificationView,
  type CommunityInbox,
  type CommunityNotification,
  type CommunityNotificationKeysetPosition,
  type CommunityNotificationPreference,
  type CommunityNotificationPreferenceRecord,
  type CommunityNotificationRow,
} from './community-notification.js';
import {
  COMMUNITY_NOTIFICATIONS_ENDPOINT,
  COMMUNITY_NOTIFICATION_CURSOR_TTL_MS,
  communityNotificationInvalidCursor,
  type CommunityNotificationCursorCodec,
  type CommunityNotificationCursorPayload,
  type CommunityNotificationReadFilter,
} from './community-notification-cursor.js';
import {
  communityCommentAuthorView,
  communityCommentMatchesGeneration,
  type CommunityCommentRecord,
} from './community-comment.js';
import type {
  CommunityTargetIdentity,
  CommunityTargetQuery,
} from './community-target.js';
import type { ResolvedCommunityTarget } from './community-target-query.js';
import type { CommunityCommentLiveAuthor } from './community-comment-query.js';

const CURSOR_TEXT = /^[A-Za-z0-9._~-]{1,2048}$/u;
const BASE10 = /^[0-9]+$/u;
/** Rows fetched per scan pass while concealed rows are skipped. */
const SCAN_BATCH_LIMIT = 100;
/**
 * Per-request scan budget: every scanned row costs comment loads and a
 * live target resolve, so a page must not walk an arbitrarily deep run of
 * concealed notifications in one call. At the cap the page stops early and
 * the cursor resumes at `after` — the skipped stretch was already proven
 * dead, so nothing servable is lost and the next page never re-scans it.
 */
const MAX_SCAN_ROWS = SCAN_BATCH_LIMIT * 8;

/**
 * CS-05: a serialized inbox page ({items, nextCursor, unreadCount}) is
 * bounded by this many UTF-8 bytes on top of the requested item limit. A
 * byte-limited short page still returns a nextCursor positioned at the
 * last served row, so the continuation resumes at the first unconsumed
 * eligible item.
 *
 * Serialized-page cursor accounting is EXACT, not reserved (the comment
 * pagination pattern): for every candidate item the fill loop measures
 * the real `nextCursor` token via `cursorCodec.encodedLength` on the very
 * payload `sign` would emit (same endpoint, viewer, filter, limit, and
 * `pos` bound to that item). The `null` placeholder serialized by
 * `pageBytes` (4 bytes) is replaced by `"<token>"` (token + 2 quote
 * bytes), so a candidate fits iff
 * `pageBytes + tokenBytes - 2 <= COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET`.
 */
export const COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET = 65_536;

export const COMMUNITY_NOTIFICATION_INBOX_CONCEALED_MESSAGE =
  'The community notification inbox was not found.';

/** Normalized inbox query; defaults `read=all`, `limit=20`. */
export interface CommunityNotificationsQuery {
  readonly read: CommunityNotificationReadFilter;
  readonly limit: number;
  readonly cursor: string | null;
}

/** One unread-count group keyed by the reply comment's pinned target. */
export interface CommunityNotificationUnreadGroup {
  readonly target: CommunityTargetIdentity;
  readonly targetGeneration: string;
  readonly count: number;
}

export interface CommunityNotificationQueryPorts {
  readonly account: {
    /** Active account facts; null when the recipient account is gone. */
    findActive(accountId: string): Promise<{
      readonly accountId: string;
      readonly subjectId: string;
      readonly createdAt: Date;
    } | null>;
  };
  readonly preferences: {
    /** Community channel row; null until the first PUT. */
    findCommunity(recipientAccountId: string): Promise<CommunityNotificationPreferenceRecord | null>;
  };
  readonly notifications: {
    /**
     * `comment_reply` rows of one recipient ordered `occurredAt DESC,
     * notificationId DESC` after the keyset position; `state` narrows to
     * unread only. At most `limit` rows.
     */
    page(
      recipientAccountId: string,
      state: 'unread' | undefined,
      after: CommunityNotificationKeysetPosition | null,
      limit: number,
    ): Promise<readonly CommunityNotificationRow[]>;
    /**
     * Unread `comment_reply` rows grouped by the reply comment's pinned
     * target identity + generation (rows whose comment row is gone never
     * join, so they never count).
     */
    unreadGroups(recipientAccountId: string): Promise<readonly CommunityNotificationUnreadGroup[]>;
  };
  readonly comments: {
    /** Durable comment rows keyed by id; missing ids are absent entries. */
    findMany(commentIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentRecord>>;
  };
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /** Batch form, positionally aligned; one statement per kind when provided. */
    resolveMany?(queries: readonly CommunityTargetQuery[]):
      Promise<readonly (ResolvedCommunityTarget | null)[]>;
  };
  readonly authors: {
    publicActors(accountIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentLiveAuthor>>;
  };
  readonly clock: { now(): Promise<Date> };
}

function invalidQuery(message: string): CommunityNotificationError {
  return new CommunityNotificationError('invalid_query', message);
}
function invalidCursor(): CommunityNotificationError {
  return communityNotificationInvalidCursor();
}
function concealed(): CommunityNotificationError {
  return new CommunityNotificationError(
    'resource_not_found', COMMUNITY_NOTIFICATION_INBOX_CONCEALED_MESSAGE,
  );
}

const QUERY_KEYS = ['cursor', 'limit', 'read'] as const;

/**
 * Parse the closed inbox query {read?, limit?, cursor?}. `read` is
 * 'all'|'unread' (default 'all'); `limit` is 1..100 (default 20); `cursor`
 * is the opaque token or absent. Unknown keys reject; null is never
 * equivalent to missing.
 */
export function parseCommunityNotificationsQuery(
  raw: Readonly<Record<string, unknown>>,
): CommunityNotificationsQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidQuery('The community notifications query is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) {
      throw invalidQuery('The community notifications query is invalid.');
    }
  }
  const read = raw.read === undefined ? 'all' : raw.read;
  if (read !== 'all' && read !== 'unread') {
    throw invalidQuery('The community notifications read filter is invalid.');
  }
  const limit = raw.limit === undefined
    ? COMMUNITY_NOTIFICATION_INBOX_DEFAULT_LIMIT
    : normalizeLimit(raw.limit);
  const cursor = raw.cursor === undefined ? null : normalizeCursor(raw.cursor);
  return Object.freeze<CommunityNotificationsQuery>({ read, limit, cursor });
}

function normalizeLimit(value: unknown): number {
  let parsed: number;
  if (typeof value === 'string') {
    if (!BASE10.test(value)) throw invalidQuery('The community notifications limit is invalid.');
    parsed = Number.parseInt(value, 10);
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    parsed = value;
  } else {
    throw invalidQuery('The community notifications limit is invalid.');
  }
  if (parsed < 1 || parsed > COMMUNITY_NOTIFICATION_INBOX_MAX_LIMIT) {
    throw invalidQuery('The community notifications limit is invalid.');
  }
  return parsed;
}

function normalizeCursor(value: unknown): string {
  if (typeof value !== 'string' || !CURSOR_TEXT.test(value)) throw invalidCursor();
  return value;
}

export function communityNotificationTargetQuery(
  identity: CommunityTargetIdentity,
): CommunityTargetQuery {
  return {
    kind: identity.kind,
    id: identity.id,
    ...(identity.collectionId !== null ? { collectionId: identity.collectionId } : {}),
    ...(identity.seriesId !== null ? { seriesId: identity.seriesId } : {}),
  };
}

/** Resolution-cache key for one closed target identity (parents included). */
export function communityNotificationTargetCacheKey(identity: CommunityTargetIdentity): string {
  return `${identity.kind}:${identity.id}:${identity.collectionId ?? ''}:${identity.seriesId ?? ''}`;
}

const targetCacheKey = communityNotificationTargetCacheKey;

/**
 * Resolve each distinct target once; misses resolve to null.
 *
 * Distinct targets are resolved as one batch where the host offers it. The
 * sequential form costs a round trip per target — and an unread backlog can
 * carry hundreds of groups — so the batch is what keeps a page's cost tied to
 * the number of target *kinds* rather than the number of rows.
 */
async function resolveTargets(
  ports: Pick<CommunityNotificationQueryPorts, 'targets'>,
  identities: readonly CommunityTargetIdentity[],
): Promise<ReadonlyMap<string, ResolvedCommunityTarget | null>> {
  const cache = new Map<string, ResolvedCommunityTarget | null>();
  const distinct: CommunityTargetIdentity[] = [];
  for (const identity of identities) {
    const key = targetCacheKey(identity);
    if (cache.has(key)) continue;
    cache.set(key, null);
    distinct.push(identity);
  }
  if (distinct.length === 0) return cache;
  if (ports.targets.resolveMany === undefined) {
    for (const identity of distinct) {
      cache.set(targetCacheKey(identity), await ports.targets.resolve(communityNotificationTargetQuery(identity)));
    }
    return cache;
  }
  const resolved = await ports.targets.resolveMany(distinct.map(communityNotificationTargetQuery));
  distinct.forEach((identity, index) => {
    cache.set(targetCacheKey(identity), resolved[index] ?? null);
  });
  return cache;
}

/**
 * Whether a durable row is still servable: its reply comment exists, its
 * target still resolves, and the pinned generation is still current.
 * Tombstoned (deleted/hidden) comments stay servable — the preview is
 * redacted but the row keeps its position.
 */
function servable(
  record: CommunityCommentRecord | undefined,
  resolvedByKey: ReadonlyMap<string, ResolvedCommunityTarget | null>,
): { readonly record: CommunityCommentRecord; readonly resolved: ResolvedCommunityTarget } | null {
  if (record === undefined) return null;
  const resolved = resolvedByKey.get(targetCacheKey(record.target)) ?? null;
  if (resolved === null || !communityCommentMatchesGeneration(record, resolved.target.generation)) {
    return null;
  }
  return { record, resolved };
}

function notificationPageBytes(
  items: readonly CommunityNotification[],
  unreadCount: number,
): number {
  // Envelope with a null cursor; the exact encoded cursor allowance for
  // the candidate's own `pos` is added per item by the fill loop.
  return Buffer.byteLength(
    JSON.stringify({ items, nextCursor: null, unreadCount }), 'utf8',
  );
}

/**
 * Exact UTF-8 size of the page if `cursorTokenBytes` replaces the `null`
 * placeholder: `null` is 4 bytes, `"<token>"` is token + 2 bytes.
 */
function notificationPageBytesWithCursor(
  items: readonly CommunityNotification[],
  unreadCount: number,
  cursorTokenBytes: number,
): number {
  return notificationPageBytes(items, unreadCount) + cursorTokenBytes - 2;
}

/**
 * Page the viewer's community reply notifications. The cursor binds the
 * endpoint, viewer, read filter, and limit; every row is re-proven against
 * the live comment + target authority before it is served, `unreadCount`
 * counts only servable rows, and the serialized page is bounded by
 * COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET on top of `query.limit`.
 */
export async function listCommunityNotifications(
  ports: CommunityNotificationQueryPorts,
  input: {
    readonly viewer: { readonly accountId: string; readonly subjectId: string };
    readonly query: CommunityNotificationsQuery;
    readonly cursorCodec: CommunityNotificationCursorCodec;
  },
): Promise<CommunityInbox> {
  const { query } = input;
  const account = await ports.account.findActive(input.viewer.accountId);
  if (account === null || account.subjectId !== input.viewer.subjectId) throw concealed();
  const now = await ports.clock.now();
  let after: CommunityNotificationKeysetPosition | null = null;
  if (query.cursor !== null) {
    let payload: CommunityNotificationCursorPayload;
    try {
      payload = input.cursorCodec.verify(query.cursor, now);
    } catch {
      throw invalidCursor();
    }
    if (payload.ep !== COMMUNITY_NOTIFICATIONS_ENDPOINT
        || payload.vw !== account.accountId
        || payload.ft !== query.read
        || payload.lm !== query.limit) {
      throw invalidCursor();
    }
    after = { occurredAt: new Date(payload.pos.t), notificationId: payload.pos.i };
  }
  const preference = await ports.preferences.findCommunity(account.accountId);
  if (preference !== null && !preference.enabled) {
    return Object.freeze<CommunityInbox>({ items: [], nextCursor: null, unreadCount: 0 });
  }
  const state = query.read === 'unread' ? 'unread' as const : undefined;
  const servedRows: { row: CommunityNotificationRow; record: CommunityCommentRecord; resolved: ResolvedCommunityTarget }[] = [];
  const records = new Map<string, CommunityCommentRecord>();
  const resolvedByKey = new Map<string, ResolvedCommunityTarget | null>();
  let exhausted = false;
  let scanned = 0;
  // Concealed rows are skipped; loop until `limit` servable items, the
  // scan budget, or the recipient's history is exhausted. `after` tracks
  // the last EXAMINED row, so every position it passes is settled.
  while (servedRows.length < query.limit && !exhausted && scanned < MAX_SCAN_ROWS) {
    const fetchLimit = Math.min(
      Math.max(query.limit - servedRows.length + 1, 1), SCAN_BATCH_LIMIT,
    );
    const batch = await ports.notifications.page(account.accountId, state, after, fetchLimit);
    if (batch.length < fetchLimit) exhausted = true;
    scanned += batch.length;
    const missing = batch.map((row) => row.subjectId).filter((id) => !records.has(id));
    if (missing.length > 0) {
      for (const [id, record] of await ports.comments.findMany(missing)) records.set(id, record);
    }
    const identities = [...new Map(batch
      .map((row) => records.get(row.subjectId)?.target)
      .filter((target): target is CommunityTargetIdentity => target !== undefined)
      .map((target) => [targetCacheKey(target), target] as const)).values()];
    for (const [key, resolved] of await resolveTargets(ports, identities)) {
      resolvedByKey.set(key, resolved);
    }
    for (const row of batch) {
      if (servedRows.length >= query.limit) break;
      after = { occurredAt: row.occurredAt, notificationId: row.notificationId };
      const served = servable(records.get(row.subjectId), resolvedByKey);
      if (served !== null) servedRows.push({ row, ...served });
    }
  }
  // The unread count lands in the serialized page, so it is measured into
  // the byte budget exactly — compute it before the fill loop.
  const unreadCount = await countServableUnread(
    ports, account.accountId, resolvedByKey,
  );
  const actorIds = [...new Set(servedRows.map(({ row, record }) =>
    row.actorProfileId ?? record.authorAccountId))];
  const liveAuthors = actorIds.length === 0
    ? new Map<string, CommunityCommentLiveAuthor>()
    : await ports.authors.publicActors(actorIds);
  // One payload builder feeds both the exact byte measurement and `sign`,
  // so the budget check can never drift from the emitted token.
  const cursorPayload = (pos: { occurredAt: Date; notificationId: string }): CommunityNotificationCursorPayload => ({
    v: 1,
    ep: COMMUNITY_NOTIFICATIONS_ENDPOINT,
    vw: account.accountId,
    ft: query.read,
    lm: query.limit,
    pos: { t: pos.occurredAt.toISOString(), i: pos.notificationId },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMMUNITY_NOTIFICATION_CURSOR_TTL_MS).toISOString(),
  });
  // Fill the page until the item limit OR the serialized-byte budget cuts
  // the next candidate; `lastIncluded` stays bound to the last emitted row.
  const items: CommunityNotification[] = [];
  let lastIncluded: CommunityNotificationRow | null = null;
  for (const { row, record, resolved } of servedRows) {
    const view = communityNotificationView(row, record, resolved,
      communityCommentAuthorView(
        row.actorProfileId ?? record.authorAccountId,
        liveAuthors.get(row.actorProfileId ?? record.authorAccountId) ?? null,
      ));
    // The FIRST servable item is admitted unconditionally: an empty page
    // cut on budget has `lastIncluded` null — `resume` would be null and
    // the remaining servable rows silently truncated behind
    // `nextCursor:null`. The budget bounds only candidates after the first.
    if (items.length > 0 && notificationPageBytesWithCursor(
      [...items, view], unreadCount,
      input.cursorCodec.encodedLength(cursorPayload(row)),
    ) > COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET) {
      break;
    }
    items.push(view);
    lastIncluded = row;
  }
  // `more` covers both directions: servable candidates cut by the byte
  // budget, and history the scan never reached (limit, scan budget, or
  // tail). The cursor resumes at the last INCLUDED row when a byte cut
  // left served items unclaimed — so they lead the next page — and at
  // `after` otherwise, since everything the scan passed was settled.
  const more = items.length < servedRows.length || !exhausted;
  const resume = items.length < servedRows.length
    ? (lastIncluded !== null
        ? { occurredAt: lastIncluded.occurredAt, notificationId: lastIncluded.notificationId }
        : null)
    : after;
  const nextCursor = more && resume !== null
    ? input.cursorCodec.sign(cursorPayload(resume))
    : null;
  return Object.freeze<CommunityInbox>({
    items: Object.freeze(items), nextCursor, unreadCount,
  });
}

/** The minimal port surface behind the servable unread count. */
export interface CommunityNotificationUnreadPorts {
  readonly notifications: {
    unreadGroups(recipientAccountId: string): Promise<readonly CommunityNotificationUnreadGroup[]>;
  };
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /** Batch form, positionally aligned; one statement per kind when provided. */
    resolveMany?(queries: readonly CommunityTargetQuery[]):
      Promise<readonly (ResolvedCommunityTarget | null)[]>;
  };
}

/**
 * Count servable unread rows: unread notifications grouped by pinned
 * target; a group counts only while its target resolves and the pinned
 * generation is still current. The caller's resolution cache is reused so
 * the page's targets never resolve twice.
 */
export async function countServableUnread(
  ports: CommunityNotificationUnreadPorts,
  recipientAccountId: string,
  resolvedByKey?: ReadonlyMap<string, ResolvedCommunityTarget | null>,
): Promise<number> {
  const groups = await ports.notifications.unreadGroups(recipientAccountId);
  const fresh = await resolveTargets(ports, groups.map((group) => group.target));
  let count = 0;
  for (const group of groups) {
    const key = targetCacheKey(group.target);
    const resolved = resolvedByKey?.has(key)
      ? resolvedByKey.get(key) ?? null
      : fresh.get(key) ?? null;
    if (resolved === null || group.targetGeneration !== resolved.target.generation) continue;
    count += group.count;
  }
  return count;
}

/**
 * Read the viewer's community notification preference. The durable row is
 * absent until the first PUT; the virtual default (enabled, revision '1',
 * `updatedAt` = account creation) is served meanwhile.
 */
export async function getCommunityNotificationPreference(
  ports: CommunityNotificationQueryPorts,
  input: {
    readonly viewer: { readonly accountId: string; readonly subjectId: string };
  },
): Promise<CommunityNotificationPreference> {
  const account = await ports.account.findActive(input.viewer.accountId);
  if (account === null || account.subjectId !== input.viewer.subjectId) throw concealed();
  const record = await ports.preferences.findCommunity(account.accountId);
  if (record !== null) return communityNotificationPreferenceView(record);
  return communityNotificationPreferenceVirtual(account.createdAt);
}
