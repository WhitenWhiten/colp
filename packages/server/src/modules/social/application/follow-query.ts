import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';
import {
  FOLLOWERS_CURSOR_PURPOSE, FOLLOWING_CURSOR_PURPOSE, FOLLOW_CURSOR_COMPARATOR_VERSION, FOLLOW_CURSOR_TTL_MS,
  FollowCursorError, type FollowCursorAfter, type FollowCursorKeyring,
} from './follow-cursor.js';

export const FOLLOW_PAGE_DEFAULT_LIMIT = 30;
export const FOLLOW_PAGE_MAX_LIMIT = 100;
export interface FollowProfileSummary { readonly profileId: string; readonly handle: string; readonly displayName: string; readonly avatarUrl: string | null; }
export interface FollowProfileFact { readonly profile: FollowProfileSummary; readonly followedAt: Date; }
export interface FollowPageReadInput { readonly targetProfileId: string; readonly limit: number; readonly after?: { readonly followedAt: Date; readonly profileId: string }; readonly signal?: AbortSignal; }
export interface FollowPageReadPort {
  listFollowers(input: FollowPageReadInput): Promise<readonly FollowProfileFact[] | null>;
  listFollowing(input: FollowPageReadInput): Promise<readonly FollowProfileFact[] | null>;
}
export interface FollowQueryInput { readonly principalId: string; readonly targetProfileId: string; readonly direction: 'followers'|'following'; readonly limit?: number; readonly cursor?: string; readonly filter?: string; readonly signal?: AbortSignal; }
export interface FollowQueryPage { readonly items: readonly FollowProfileSummary[]; readonly nextCursor: string | null; }
export interface FollowQueryPorts { readonly reads: FollowPageReadPort; readonly cursors: FollowCursorKeyring; readonly clock: { now(): Promise<Date> }; }

export async function queryFollowRelations(ports: FollowQueryPorts, input: FollowQueryInput): Promise<FollowQueryPage | null> {
  const principalId = identity(input.principalId); const profileId = identity(input.targetProfileId);
  if (input.direction !== 'followers' && input.direction !== 'following') throw new TypeError('invalid Follow direction');
  const now = await validClock(ports); const requestedFilter = normalizeFilter(input.filter);
  if (input.cursor === undefined && requestedFilter !== '') throw new TypeError('Follow filters are not supported by the frozen contract');
  let limit = normalizeLimit(input.limit); let filter = requestedFilter; let after: FollowCursorAfter | undefined;
  let issuedAt = now.toISOString(); let expiresAt = new Date(now.getTime() + FOLLOW_CURSOR_TTL_MS).toISOString();
  if (input.cursor !== undefined) {
    const cursor = ports.cursors[input.direction].verify(input.cursor, now);
    const boundProfileId = input.direction === 'followers' ? cursor.targetProfileId : cursor.actorProfileId;
    if (cursor.principalId !== principalId || cursor.direction !== input.direction || boundProfileId !== profileId
      || cursor.filter !== requestedFilter || (input.limit !== undefined && cursor.limit !== limit)
      || cursor.comparatorVersion !== FOLLOW_CURSOR_COMPARATOR_VERSION) throw new FollowCursorError();
    limit = cursor.limit; filter = cursor.filter; after = cursor.after; issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  }
  const readInput: FollowPageReadInput = { targetProfileId: profileId, limit,
    ...(after ? { after: { followedAt: new Date(after.followedAt), profileId: after.profileId } } : {}),
    ...(input.signal ? { signal: input.signal } : {}) };
  const rows = await (input.direction === 'followers' ? ports.reads.listFollowers(readInput) : ports.reads.listFollowing(readInput));
  if (rows === null) return null;
  if (rows.length > limit + 1) throw new Error('Follow read port exceeded limit+1 contract');
  assertRows(rows);
  const page = rows.slice(0, limit); const last = page.at(-1);
  const codec = ports.cursors[input.direction];
  const nextCursor = rows.length > limit && last ? codec.seal({ v: 1,
    purpose: input.direction === 'followers' ? FOLLOWERS_CURSOR_PURPOSE : FOLLOWING_CURSOR_PURPOSE,
    direction: input.direction, principalId, targetProfileId: input.direction === 'followers' ? profileId : null,
    actorProfileId: input.direction === 'following' ? profileId : null, filter, limit,
    comparatorVersion: FOLLOW_CURSOR_COMPARATOR_VERSION,
    after: { followedAt: last.followedAt.toISOString(), profileId: last.profile.profileId }, issuedAt, expiresAt }) : null;
  return Object.freeze({ items: Object.freeze(page.map((row) => Object.freeze({ ...row.profile }))), nextCursor });
}
function normalizeLimit(value: number | undefined): number { if (value === undefined) return FOLLOW_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > FOLLOW_PAGE_MAX_LIMIT) throw new TypeError('Follow limit must be an integer from 1 to 100'); return value; }
function normalizeFilter(value: string | undefined): string { if (value === undefined) return ''; if (typeof value !== 'string') throw new TypeError('invalid Follow filter');
  const normalized = value.trim().toLowerCase(); if (normalized.length > 128) throw new TypeError('invalid Follow filter'); return normalized; }
function identity(value: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || value.length > SOCIAL_IDENTITY_MAX_LENGTH) {
    throw new TypeError('invalid Profile identity');
  }
  return value;
}
async function validClock(ports: FollowQueryPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid Follow query clock');
  }
  return now;
}
function assertRows(rows: readonly FollowProfileFact[]): void { for (let index = 0; index < rows.length; index += 1) { const row = rows[index]!;
    identity(row.profile.profileId); if (!(row.followedAt instanceof Date) || !Number.isFinite(row.followedAt.getTime())
      || !safeHandle(row.profile.handle) || typeof row.profile.displayName !== 'string'
      || row.profile.displayName.length < 1 || row.profile.displayName.length > 120
      || !safeAvatarUrl(row.profile.avatarUrl)) throw new Error('invalid Follow Profile projection');
    const previous = rows[index - 1]; if (previous && !(previous.followedAt > row.followedAt
      || (previous.followedAt.getTime() === row.followedAt.getTime() && previous.profile.profileId > row.profile.profileId))) throw new Error('Follow read port violated comparator');
  } }
function safeHandle(value: unknown): value is string { return typeof value === 'string' && value !== '.' && value !== '..'
  && /^[a-z0-9._~-]{1,64}$/u.test(value); }
function safeAvatarUrl(value: unknown): value is string|null { if (value === null) return true; if (typeof value !== 'string') return false;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''; }
  catch { return false; } }
