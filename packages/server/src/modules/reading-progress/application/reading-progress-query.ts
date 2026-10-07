import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../../commands/index.js';
import type { ReadingProgressRecord, ReadingProgressResourceType, ReadingProgressStatus } from './reading-progress.js';

export const READING_PROGRESS_PAGE_DEFAULT_LIMIT = 20;
export const READING_PROGRESS_PAGE_MAX_LIMIT = 100;
export const READING_PROGRESS_CURSOR_PURPOSE = 'product-reading-progress-cursor';
export const READING_PROGRESS_COMPARATOR_VERSION = 'updated-desc-type-asc-id-asc-v1';
const CURSOR_TTL_MS = 15 * 60 * 1000;

export interface ReadingProgressCursorAfter { updatedAt: string; resourceType: ReadingProgressResourceType; resourceId: string }
interface ReadingProgressCursorPayload { v: 1; purpose: typeof READING_PROGRESS_CURSOR_PURPOSE; keyVersion: string;
  accountId: string; filters: { status: ReadingProgressStatus | null }; limit: number;
  comparatorVersion: typeof READING_PROGRESS_COMPARATOR_VERSION; after: ReadingProgressCursorAfter;
  issuedAt: string; expiresAt: string }
export interface ReadingProgressCursorKeyMaterial { current: { id: string; key: string };
  previous?: readonly { id: string; key: string; retainUntil?: string }[] }
export interface ReadingProgressCursorSignerPort { readonly currentKeyId: string;
  sign(payload: ReadingProgressCursorPayload): string; verify(token: string, now: Date): ReadingProgressCursorPayload }
export class ReadingProgressQueryError extends Error {
  constructor(readonly code: 'invalid_reading_progress_query' | 'invalid_cursor') {
    super(code === 'invalid_cursor' ? 'The Reading Progress cursor is invalid.' : 'The Reading Progress query is invalid.');
    this.name = 'ReadingProgressQueryError';
  }
}

export function createReadingProgressCursorSigner(material: ReadingProgressCursorKeyMaterial): ReadingProgressCursorSignerPort {
  const keys: { id: string; key: string; retainUntil?: string; derived: string }[] = [
    material.current, ...(material.previous ?? []),
  ].map((key) => ({ ...key,
    derived: createHmac('sha256', key.key).update(READING_PROGRESS_CURSOR_PURPOSE).digest('base64url') }));
  if (new Set(keys.map((key) => key.id)).size !== keys.length || keys.some((key) => !key.id || key.key.length < 16
    || (key.retainUntil !== undefined && !Number.isFinite(Date.parse(key.retainUntil))))) throw new TypeError('Invalid Reading Progress cursor keyring.');
  return { currentKeyId: material.current.id,
    sign(payload) { validateCursor(payload); if (payload.keyVersion !== material.current.id) throw new ReadingProgressQueryError('invalid_cursor');
      const encoded = Buffer.from(canonicalJson(payload)).toString('base64url'); const key = keys[0]!;
      return `${key.id}.${encoded}.${createHmac('sha256', key.derived).update(encoded).digest('base64url')}`; },
    verify(token, now) { try { const [id, encoded, signature, ...extra] = token.split('.');
        if (!id || !encoded || !signature || extra.length || token.length > 2048) throw new Error();
        const key = keys.find((candidate) => candidate.id === id);
        if (!key || (key.retainUntil && now >= new Date(key.retainUntil))) throw new Error();
        const expected = Buffer.from(createHmac('sha256', key.derived).update(encoded).digest('base64url'));
        const supplied = Buffer.from(signature); if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as ReadingProgressCursorPayload;
        validateCursor(payload); if (payload.keyVersion !== id || now >= new Date(payload.expiresAt)) throw new Error(); return payload;
      } catch { throw new ReadingProgressQueryError('invalid_cursor'); } } };
}
function validateCursor(value: ReadingProgressCursorPayload) {
  if (!value || value.v !== 1 || value.purpose !== READING_PROGRESS_CURSOR_PURPOSE
    || value.comparatorVersion !== READING_PROGRESS_COMPARATOR_VERSION || !value.accountId || !value.keyVersion
    || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > READING_PROGRESS_PAGE_MAX_LIMIT
    || (value.filters.status !== null && !isStatus(value.filters.status)) || !value.after
    || !isType(value.after.resourceType) || !value.after.resourceId || !validDate(value.after.updatedAt)
    || !validDate(value.issuedAt) || !validDate(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > CURSOR_TTL_MS) throw new ReadingProgressQueryError('invalid_cursor');
}

export interface ReadingProgressTargetSummaryRow { resourceType: ReadingProgressResourceType; resourceId: string;
  collectionId: string; title: string; url: string | null }
export interface ReadingProgressReadPort {
  get(input: { accountId: string; resourceType: ReadingProgressResourceType; resourceId: string }): Promise<ReadingProgressRecord | null>;
  list(input: { accountId: string; status?: ReadingProgressStatus; limit: number; after?: ReadingProgressCursorAfter }): Promise<readonly ReadingProgressRecord[]>;
  hydrateAccessible(input: { actorSubjectId: string; targets: readonly { resourceType: ReadingProgressResourceType; resourceId: string }[] }): Promise<readonly ReadingProgressTargetSummaryRow[]>;
}
export interface ReadingProgressReadPorts { reads: ReadingProgressReadPort; cursorSigner: ReadingProgressCursorSignerPort;
  clock: { now(): Promise<Date> }; cursorTtlMs?: number }
export interface ReadingProgressReadUnitOfWork {
  execute<T>(work: (ports: ReadingProgressReadPorts) => Promise<T>, request?: { readonly signal?: AbortSignal }): Promise<T>;
}
export interface ReadingProgressView { resourceType: ReadingProgressResourceType; resourceId: string;
  status: ReadingProgressStatus; progress: number; completedAt: string | null; updatedAt: string; etag: string;
  target: { availability: 'available' | 'unavailable'; collectionId: string | null; title: string | null; url: string | null } }

export function readingProgressEtag(record: Pick<ReadingProgressRecord, 'accountId' | 'resourceType' | 'resourceId' | 'status' | 'progress' | 'revision' | 'completedAt' | 'updatedAt'>): string {
  const digest = createHash('sha256').update(canonicalJson({ contract: 'reading-progress-item-v1', accountId: record.accountId,
    resourceType: record.resourceType, resourceId: record.resourceId, status: record.status, progress: record.progress,
    revision: record.revision, completedAt: record.completedAt?.toISOString() ?? null, updatedAt: record.updatedAt.toISOString() })).digest('base64url');
  return `"reading-progress:${digest}"`;
}

export async function getReadingProgressItem(ports: ReadingProgressReadPorts, input: { actor: Actor;
  resourceType: ReadingProgressResourceType; resourceId: string }): Promise<ReadingProgressView | null> {
  assertActor(input.actor); if (!isType(input.resourceType) || !input.resourceId || input.resourceId !== input.resourceId.trim()) throw new ReadingProgressQueryError('invalid_reading_progress_query');
  const row = await ports.reads.get({ accountId: input.actor.accountId, resourceType: input.resourceType, resourceId: input.resourceId });
  if (!row) return null;
  const summaries = await ports.reads.hydrateAccessible({ actorSubjectId: input.actor.subjectId,
    targets: [{ resourceType: row.resourceType, resourceId: row.resourceId }] });
  return view(row, summaries[0]);
}

interface Actor { accountId: string; principalId: string; subjectId: string }
export async function getReadingProgressPage(ports: ReadingProgressReadPorts, input: { actor: Actor;
  status?: ReadingProgressStatus; limit?: number; cursor?: string }) {
  assertActor(input.actor); const filters = { status: input.status ?? null };
  if (filters.status !== null && !isStatus(filters.status)) throw new ReadingProgressQueryError('invalid_reading_progress_query');
  const now = await ports.clock.now(); let limit = input.limit ?? READING_PROGRESS_PAGE_DEFAULT_LIMIT;
  let after: ReadingProgressCursorAfter | undefined; let issuedAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + (ports.cursorTtlMs ?? CURSOR_TTL_MS)).toISOString();
  if (!Number.isInteger(limit) || limit < 1 || limit > READING_PROGRESS_PAGE_MAX_LIMIT) throw new ReadingProgressQueryError('invalid_reading_progress_query');
  if (input.cursor) { if (input.limit !== undefined) throw new ReadingProgressQueryError('invalid_reading_progress_query');
    const cursor = ports.cursorSigner.verify(input.cursor, now);
    if (cursor.accountId !== input.actor.accountId || canonicalJson(cursor.filters) !== canonicalJson(filters)) throw new ReadingProgressQueryError('invalid_cursor');
    ({ limit, after, issuedAt, expiresAt } = cursor); }
  const rows = await ports.reads.list({ accountId: input.actor.accountId, ...(filters.status ? { status: filters.status } : {}), limit, ...(after ? { after } : {}) });
  const pageRows = rows.slice(0, limit); const summaries = await ports.reads.hydrateAccessible({ actorSubjectId: input.actor.subjectId,
    targets: pageRows.map(({ resourceType, resourceId }) => ({ resourceType, resourceId })) });
  const byTarget = new Map(summaries.map((summary) => [`${summary.resourceType}:${summary.resourceId}`, summary]));
  const items = pageRows.map((row) => view(row, byTarget.get(`${row.resourceType}:${row.resourceId}`)));
  const last = pageRows.at(-1); const hasMore = rows.length > limit;
  const nextCursor = hasMore && last ? ports.cursorSigner.sign({ v: 1, purpose: READING_PROGRESS_CURSOR_PURPOSE,
    keyVersion: ports.cursorSigner.currentKeyId, accountId: input.actor.accountId, filters, limit,
    comparatorVersion: READING_PROGRESS_COMPARATOR_VERSION, after: { updatedAt: last.updatedAt.toISOString(),
      resourceType: last.resourceType, resourceId: last.resourceId }, issuedAt, expiresAt }) : null;
  return Object.freeze({ items: Object.freeze(items), page: Object.freeze({ returnedCount: items.length, hasMore, nextCursor }) });
}
function view(row: ReadingProgressRecord, summary?: ReadingProgressTargetSummaryRow): ReadingProgressView {
  return Object.freeze({ resourceType: row.resourceType, resourceId: row.resourceId, status: row.status,
    progress: row.progress, completedAt: row.completedAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(), etag: readingProgressEtag(row),
    target: summary ? Object.freeze({ availability: 'available' as const, collectionId: summary.collectionId, title: summary.title, url: summary.url })
      : Object.freeze({ availability: 'unavailable' as const, collectionId: null, title: null, url: null }) });
}
function assertActor(actor: Actor) { if (!actor.accountId || !actor.principalId || !actor.subjectId) throw new ReadingProgressQueryError('invalid_reading_progress_query'); }
function isType(value: unknown): value is ReadingProgressResourceType { return value === 'collection' || value === 'node'; }
function isStatus(value: unknown): value is ReadingProgressStatus { return value === 'not_started' || value === 'in_progress' || value === 'completed'; }
function validDate(value: string) { return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
