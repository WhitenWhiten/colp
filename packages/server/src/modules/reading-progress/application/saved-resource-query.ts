import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type { SavedResourceType } from './saved-resource.js';

export const SAVED_RESOURCE_PAGE_DEFAULT_LIMIT = 20;
export const SAVED_RESOURCE_PAGE_MAX_LIMIT = 100;
export const SAVED_RESOURCE_CURSOR_PURPOSE = 'product-saved-resource-cursor';
export const SAVED_RESOURCE_COMPARATOR_VERSION = 'saved-desc-type-asc-id-asc-v1';
const TTL = 15 * 60 * 1000;
export interface SavedResourceCursorAfter { savedAt: string; resourceType: SavedResourceType; resourceId: string }
interface CursorPayload { v: 1; purpose: typeof SAVED_RESOURCE_CURSOR_PURPOSE; keyVersion: string; accountId: string;
  filters: { resourceType: SavedResourceType | null; collectionId: string | null; createdAfter: string | null; createdBefore: string | null };
  limit: number; comparatorVersion: typeof SAVED_RESOURCE_COMPARATOR_VERSION; after: SavedResourceCursorAfter; issuedAt: string; expiresAt: string }
export interface SavedResourceCursorKeyMaterial { current: { id: string; key: string }; previous?: readonly { id: string; key: string; retainUntil?: string }[] }
export interface SavedResourceCursorSignerPort { readonly currentKeyId: string; sign(payload: CursorPayload): string; verify(token: string, now: Date): CursorPayload }
export class SavedResourceQueryError extends Error { constructor(readonly code: 'invalid_saved_resource_query' | 'invalid_cursor') {
  super(code === 'invalid_cursor' ? 'The Saved Resource cursor is invalid.' : 'The Saved Resource query is invalid.'); } }

export function createSavedResourceCursorSigner(material: SavedResourceCursorKeyMaterial): SavedResourceCursorSignerPort {
  const all: Array<{ id: string; key: string; retainUntil?: string; derived: string }> = [material.current, ...(material.previous ?? [])].map((key) => ({ ...key,
    derived: createHmac('sha256', key.key).update(SAVED_RESOURCE_CURSOR_PURPOSE).digest('base64url') }));
  if (new Set(all.map((key) => key.id)).size !== all.length || all.some((key) => !key.id || key.key.length < 16
    || (key.retainUntil !== undefined && !Number.isFinite(Date.parse(key.retainUntil))))) throw new TypeError('Invalid Saved Resource cursor keyring.');
  return { currentKeyId: material.current.id, sign(payload) { validate(payload); if (payload.keyVersion !== material.current.id) throw new SavedResourceQueryError('invalid_cursor'); const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
      const key = all[0]!; return `${key.id}.${encoded}.${createHmac('sha256', key.derived).update(encoded).digest('base64url')}`; },
    verify(token, now) { try { const [id, encoded, signature, ...extra] = token.split('.'); if (!id || !encoded || !signature || extra.length || token.length > 2048) throw 0;
        const key = all.find((candidate) => candidate.id === id); if (!key || (key.retainUntil && now >= new Date(key.retainUntil))) throw 0;
        const expected = Buffer.from(createHmac('sha256', key.derived).update(encoded).digest('base64url')); const supplied = Buffer.from(signature);
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw 0;
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as CursorPayload; validate(payload);
        if (payload.keyVersion !== id || now >= new Date(payload.expiresAt)) throw 0; return payload;
      } catch { throw new SavedResourceQueryError('invalid_cursor'); } } };
}
function validate(value: CursorPayload) { if (!value || value.v !== 1 || value.purpose !== SAVED_RESOURCE_CURSOR_PURPOSE
  || value.comparatorVersion !== SAVED_RESOURCE_COMPARATOR_VERSION || !value.accountId || !value.keyVersion
  || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100 || !value.after
  || !['collection','node'].includes(value.after.resourceType) || !value.after.resourceId
  || !Number.isFinite(Date.parse(value.after.savedAt)) || !Number.isFinite(Date.parse(value.issuedAt))
  || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > TTL) throw new SavedResourceQueryError('invalid_cursor'); }

export interface SavedResourceQueryRow { resourceType: SavedResourceType; resourceId: string; savedAt: Date }
export interface SavedResourceTargetSummaryRow { resourceType: SavedResourceType; resourceId: string; collectionId: string; title: string; url: string | null }
export interface SavedResourceReadPort {
  listLive(input: { accountId: string; resourceType?: SavedResourceType; collectionId?: string; createdAfter?: Date; createdBefore?: Date; limit: number; after?: SavedResourceCursorAfter }): Promise<readonly SavedResourceQueryRow[]>;
  hydrateAccessible(input: { actorSubjectId: string; targets: readonly { resourceType: SavedResourceType; resourceId: string }[] }): Promise<readonly SavedResourceTargetSummaryRow[]>;
}
export interface SavedResourceReadPorts { reads: SavedResourceReadPort; cursorSigner: SavedResourceCursorSignerPort; clock: { now(): Promise<Date> }; cursorTtlMs?: number }
export interface SavedResourceReadUnitOfWork {
  execute<T>(work: (ports: SavedResourceReadPorts) => Promise<T>, request?: { readonly signal?: AbortSignal }): Promise<T>;
}
export interface SavedResourceView { resourceType: SavedResourceType; resourceId: string; savedAt: string; target: { availability: 'available' | 'unavailable'; collectionId: string | null; title: string | null; url: string | null } }

export async function getSavedResourcePage(ports: SavedResourceReadPorts, input: { actor: { accountId: string; principalId: string; subjectId: string }; resourceType?: SavedResourceType; collectionId?: string; createdAfter?: string; createdBefore?: string; limit?: number; cursor?: string }) {
  const filters = normalizeFilters(input); const now = await ports.clock.now(); let limit = input.limit ?? SAVED_RESOURCE_PAGE_DEFAULT_LIMIT; let after: SavedResourceCursorAfter | undefined;
  let issuedAt = now.toISOString(); let expiresAt = new Date(now.getTime() + (ports.cursorTtlMs ?? TTL)).toISOString();
  if (!input.actor.accountId || !input.actor.subjectId || !input.actor.principalId || !Number.isInteger(limit) || limit < 1 || limit > SAVED_RESOURCE_PAGE_MAX_LIMIT) throw new SavedResourceQueryError('invalid_saved_resource_query');
  if (input.cursor) { if (input.limit !== undefined) throw new SavedResourceQueryError('invalid_saved_resource_query'); const cursor = ports.cursorSigner.verify(input.cursor, now);
    if (cursor.accountId !== input.actor.accountId || canonicalJson(cursor.filters) !== canonicalJson(filters)) throw new SavedResourceQueryError('invalid_cursor');
    ({ limit, after, issuedAt, expiresAt } = cursor); }
  const rows = await ports.reads.listLive({ accountId: input.actor.accountId, ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
    ...(filters.collectionId ? { collectionId: filters.collectionId } : {}), ...(filters.createdAfter ? { createdAfter: new Date(filters.createdAfter) } : {}),
    ...(filters.createdBefore ? { createdBefore: new Date(filters.createdBefore) } : {}), limit, ...(after ? { after } : {}) });
  const pageRows = rows.slice(0, limit); const summaries = await ports.reads.hydrateAccessible({ actorSubjectId: input.actor.subjectId,
    targets: pageRows.map(({ resourceType, resourceId }) => ({ resourceType, resourceId })) });
  const byKey = new Map(summaries.map((summary) => [`${summary.resourceType}:${summary.resourceId}`, summary]));
  const items: SavedResourceView[] = pageRows.map((row) => { const summary = byKey.get(`${row.resourceType}:${row.resourceId}`); return Object.freeze({
    resourceType: row.resourceType, resourceId: row.resourceId, savedAt: row.savedAt.toISOString(), target: summary
      ? Object.freeze({ availability: 'available' as const, collectionId: summary.collectionId, title: summary.title, url: summary.url })
      : Object.freeze({ availability: 'unavailable' as const, collectionId: null, title: null, url: null }) }); });
  const last = pageRows.at(-1); const hasMore = rows.length > limit; const nextCursor = hasMore && last ? ports.cursorSigner.sign({ v: 1,
    purpose: SAVED_RESOURCE_CURSOR_PURPOSE, keyVersion: ports.cursorSigner.currentKeyId,
    accountId: input.actor.accountId, filters, limit, comparatorVersion: SAVED_RESOURCE_COMPARATOR_VERSION,
    after: { savedAt: last.savedAt.toISOString(), resourceType: last.resourceType, resourceId: last.resourceId }, issuedAt, expiresAt }) : null;
  return Object.freeze({ items: Object.freeze(items), page: Object.freeze({ returnedCount: items.length, hasMore, nextCursor }) });
}
function normalizeFilters(input: Parameters<typeof getSavedResourcePage>[1]): CursorPayload['filters'] { if (input.resourceType && !['collection','node'].includes(input.resourceType)) throw new SavedResourceQueryError('invalid_saved_resource_query');
  const createdAfter = date(input.createdAfter); const createdBefore = date(input.createdBefore); if (createdAfter && createdBefore && createdAfter >= createdBefore) throw new SavedResourceQueryError('invalid_saved_resource_query');
  if (input.collectionId !== undefined && (!input.collectionId || input.collectionId !== input.collectionId.trim())) throw new SavedResourceQueryError('invalid_saved_resource_query');
  return { resourceType: input.resourceType ?? null, collectionId: input.collectionId ?? null, createdAfter, createdBefore }; }
function date(value?: string) { if (value === undefined) return null; const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new SavedResourceQueryError('invalid_saved_resource_query'); return value; }
