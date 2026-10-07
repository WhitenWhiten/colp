import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';
import { closedTimelineSummary } from './closed-timeline-summary.js';
import type { NotificationState, NotificationSubjectType, NotificationType } from './repository.js';
import {
  NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION, NOTIFICATION_INBOX_CURSOR_PURPOSE,
  NOTIFICATION_INBOX_CURSOR_TTL_MS, NotificationInboxCursorError,
  type NotificationInboxCursorAfter, type NotificationInboxCursorFilter,
  type NotificationInboxCursorKeyring,
} from './notification-inbox-cursor.js';

export const NOTIFICATION_INBOX_PAGE_DEFAULT_LIMIT = 30;
export const NOTIFICATION_INBOX_PAGE_MAX_LIMIT = 100;
const COLLECTION_TITLE_MAX_LENGTH = 512;
export interface NotificationInboxQueryFact {
  readonly notificationId: string; readonly notificationType: NotificationType;
  readonly actorProfileId: string | null; readonly actorHandle: string | null;
  readonly actorDisplayName: string | null; readonly subjectType: NotificationSubjectType;
  readonly subjectId: string; readonly collectionTitle: string | null;
  readonly publicationSlug: string | null; readonly summary: string | null;
  readonly state: NotificationState; readonly readAt: Date | null;
  readonly stateRevision: bigint; readonly occurredAt: Date;
}
export interface NotificationInboxPageReadInput {
  readonly principalId: string; readonly state?: NotificationState; readonly limit: number;
  readonly after?: { readonly occurredAt: Date; readonly notificationId: string };
  readonly signal?: AbortSignal;
}
export interface NotificationUnreadCountInput { readonly principalId: string; readonly signal?: AbortSignal; }
export interface NotificationInboxReadPort {
  loadPage(input: NotificationInboxPageReadInput): Promise<readonly NotificationInboxQueryFact[]>;
  countUnread(input: NotificationUnreadCountInput): Promise<number>;
}
export interface NotificationInboxQueryInput {
  readonly principalId: string; readonly state?: string; readonly limit?: number;
  readonly cursor?: string; readonly signal?: AbortSignal;
}
export interface NotificationInboxItemDto {
  readonly notificationId: string; readonly notificationType: NotificationType;
  readonly actorProfileId: string | null; readonly actorHandle: string | null;
  readonly actorDisplayName: string | null;
  readonly subject: { readonly type: NotificationSubjectType; readonly id: string };
  readonly collectionTitle: string | null; readonly publicationSlug: string | null;
  readonly summary: string | null;
  readonly state: NotificationState; readonly stateRevision: string;
  readonly readAt: string | null; readonly occurredAt: string;
}
export interface NotificationInboxQueryPage {
  readonly items: readonly NotificationInboxItemDto[];
  readonly nextCursor: string | null; readonly unreadCount: number;
}
export interface NotificationInboxQueryPorts {
  readonly reads: NotificationInboxReadPort; readonly cursors: NotificationInboxCursorKeyring;
  readonly clock: { now(): Promise<Date> };
}

export async function queryCurrentNotificationInbox(ports: NotificationInboxQueryPorts,
  input: NotificationInboxQueryInput): Promise<NotificationInboxQueryPage> {
  const principalId = identity(input.principalId); const now = await validClock(ports);
  const requestedState = normalizeState(input.state); let limit = normalizeLimit(input.limit);
  let filter: NotificationInboxCursorFilter = requestedState ?? ''; let after: NotificationInboxCursorAfter | undefined;
  let issuedAt = now.toISOString(); let expiresAt = new Date(now.getTime()
    + NOTIFICATION_INBOX_CURSOR_TTL_MS).toISOString();
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.inbox.verify(input.cursor, now);
    if (cursor.principalId !== principalId || cursor.filter !== filter
      || (input.limit !== undefined && cursor.limit !== limit)
      || cursor.comparatorVersion !== NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION) {
      throw new NotificationInboxCursorError();
    }
    limit = cursor.limit; filter = cursor.filter; after = cursor.after;
    issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  }
  const readInput = { principalId, limit, ...(filter ? { state: filter as NotificationState } : {}),
    ...(after ? { after: { occurredAt: new Date(after.occurredAt),
      notificationId: after.notificationId } } : {}), ...(input.signal ? { signal: input.signal } : {}) };
  const rows = await ports.reads.loadPage(readInput);
  if (rows.length > limit + 1) throw new Error('Notification inbox read port exceeded limit+1 contract');
  assertRows(rows);
  const unreadCount = await ports.reads.countUnread({ principalId,
    ...(input.signal ? { signal: input.signal } : {}) });
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new Error('invalid Notification unread authority count');
  }
  const page = rows.slice(0, limit); const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? ports.cursors.inbox.seal({
    v: 1, purpose: NOTIFICATION_INBOX_CURSOR_PURPOSE, principalId, filter, limit,
    comparatorVersion: NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION,
    after: { occurredAt: last.occurredAt.toISOString(), notificationId: last.notificationId },
    issuedAt, expiresAt,
  }) : null;
  return Object.freeze({ items: Object.freeze(page.map(toDto)), nextCursor, unreadCount });
}

function toDto(row: NotificationInboxQueryFact): NotificationInboxItemDto {
  return Object.freeze({ notificationId: row.notificationId, notificationType: row.notificationType,
    actorProfileId: row.actorProfileId, actorHandle: row.actorHandle,
    actorDisplayName: row.actorDisplayName,
    subject: Object.freeze({ type: row.subjectType, id: row.subjectId }),
    collectionTitle: row.collectionTitle, publicationSlug: row.publicationSlug,
    summary: closedTimelineSummary(row.notificationType,
      row.collectionTitle !== null && row.publicationSlug !== null),
    state: row.state, stateRevision: row.stateRevision.toString(), readAt: row.readAt?.toISOString() ?? null,
    occurredAt: row.occurredAt.toISOString() });
}
function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return NOTIFICATION_INBOX_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > NOTIFICATION_INBOX_PAGE_MAX_LIMIT) {
    throw new TypeError('Notification inbox limit must be an integer from 1 to 100');
  }
  return value;
}
function normalizeState(value: string | undefined): NotificationState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('invalid Notification state');
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') return undefined;
  if (normalized !== 'read' && normalized !== 'unread') throw new TypeError('invalid Notification state');
  return normalized;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.trim() !== value) throw new TypeError('invalid Account identity');
  return value;
}
async function validClock(ports: NotificationInboxQueryPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid Notification inbox query clock');
  }
  return now;
}
function assertRows(rows: readonly NotificationInboxQueryFact[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!validIdentity(row.notificationId) || !validIdentity(row.subjectId)
      || (row.actorProfileId !== null && !validIdentity(row.actorProfileId))
      || !['collection_change', 'follow_activity'].includes(row.notificationType)
      || !['collection', 'profile'].includes(row.subjectType) || !['read', 'unread'].includes(row.state)
      || typeof row.stateRevision !== 'bigint' || row.stateRevision < 0n
      || !(row.occurredAt instanceof Date) || !Number.isFinite(row.occurredAt.getTime())
      || (row.state === 'unread' ? row.readAt !== null
        : !(row.readAt instanceof Date) || !Number.isFinite(row.readAt.getTime()))
      || !validOptionalHandle(row.actorHandle) || !validOptionalDisplayName(row.actorDisplayName)
      || !validOptionalTitle(row.collectionTitle) || !validOptionalSlug(row.publicationSlug)
      || !validOptionalSummary(row.summary)) {
      throw new Error('invalid Notification inbox projection');
    }
    const previous = rows[index - 1];
    if (previous && !(previous.occurredAt > row.occurredAt
      || (previous.occurredAt.getTime() === row.occurredAt.getTime()
        && previous.notificationId > row.notificationId))) {
      throw new Error('Notification inbox read port violated comparator');
    }
  }
}
function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0
  && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function validOptionalHandle(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'string' && /^[a-z0-9._~-]{1,64}$/u.test(value)
    && value !== '.' && value !== '..';
}
function validOptionalDisplayName(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.length >= 1 && value.length <= 120;
}
function validOptionalTitle(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.length >= 1 && value.length <= COLLECTION_TITLE_MAX_LENGTH;
}
function validOptionalSlug(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(value);
}
function validOptionalSummary(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}
