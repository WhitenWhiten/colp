import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';
import { assertPageLimit } from '../domain/index.js';

export const REPORTS_CURSOR_PURPOSE = 'reports-list-v1' as const;
export const REPORTS_CURSOR_VERSION = 1 as const;
export const REPORTS_CURSOR_COMPARATOR_VERSION = 'updated-desc-id-v1' as const;
export const REPORTS_CURSOR_SORT = 'updated_at:desc,id:asc' as const;
export const REPORTS_CURSOR_TTL_MS = 15 * 60 * 1_000;

/**
 * Issue lists have a different keyset comparator from series/follow lists.
 * Keeping a separate purpose prevents a token issued for one projection from
 * being accepted by another endpoint with a subtly different ordering.
 */
export const REPORTS_ISSUE_CURSOR_PURPOSE = 'reports-issues-list-v1' as const;
export const REPORTS_ISSUE_CURSOR_COMPARATOR_VERSION = 'published-ordinal-id-v1' as const;
export const REPORTS_ISSUE_CURSOR_SORT = 'published_at:desc,edition_ordinal:desc,id:asc' as const;

export class ReportsCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'ReportsCursorError'; }
}

export interface ReportsCursorAfter { readonly updatedAt: string; readonly id: string; }
export interface ReportsCursorPayload {
  readonly v: 1;
  readonly purpose: typeof REPORTS_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly policyRevision: string;
  readonly limit: number;
  readonly sort: typeof REPORTS_CURSOR_SORT;
  readonly comparatorVersion: typeof REPORTS_CURSOR_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: ReportsCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type UnsignedReportsCursorPayload = Omit<ReportsCursorPayload, 'keyVersion'>;
export interface ReportsCursorKey { readonly id: string; readonly key: string; }
export interface RetainedReportsCursorKey extends ReportsCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ReportsCursorSigner {
  readonly sign: (payload: UnsignedReportsCursorPayload) => string;
  readonly seal: (payload: UnsignedReportsCursorPayload) => string;
  readonly verify: (token: string, now: Date) => ReportsCursorPayload;
  readonly destroy: () => void;
}

export interface ReportsIssueCursorAfter {
  readonly publishedAt: string;
  readonly editionOrdinal: number;
  readonly id: string;
}

export interface ReportsIssueCursorPayload {
  readonly v: 1;
  readonly purpose: typeof REPORTS_ISSUE_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly policyRevision: string;
  readonly limit: number;
  readonly sort: typeof REPORTS_ISSUE_CURSOR_SORT;
  readonly comparatorVersion: typeof REPORTS_ISSUE_CURSOR_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: ReportsIssueCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type UnsignedReportsIssueCursorPayload = Omit<ReportsIssueCursorPayload, 'keyVersion'>;
export interface ReportsIssueCursorSigner {
  readonly sign: (payload: UnsignedReportsIssueCursorPayload) => string;
  readonly seal: (payload: UnsignedReportsIssueCursorPayload) => string;
  readonly verify: (token: string, now: Date) => ReportsIssueCursorPayload;
  readonly destroy: () => void;
}

export function createReportsIssueCursorPayload(input: {
  readonly principalId: string;
  readonly policyRevision: string;
  readonly limit: number;
  readonly after: ReportsIssueCursorAfter;
  readonly now?: Date;
  readonly ttlMs?: number;
}): UnsignedReportsIssueCursorPayload {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? REPORTS_CURSOR_TTL_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(ttlMs)
    || ttlMs < 1 || ttlMs > REPORTS_CURSOR_TTL_MS) throw new ReportsCursorError();
  return {
    v: REPORTS_CURSOR_VERSION,
    purpose: REPORTS_ISSUE_CURSOR_PURPOSE,
    principalId: input.principalId,
    policyRevision: input.policyRevision,
    limit: input.limit,
    sort: REPORTS_ISSUE_CURSOR_SORT,
    comparatorVersion: REPORTS_ISSUE_CURSOR_COMPARATOR_VERSION,
    after: input.after,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

const PAYLOAD_KEYS = ['after', 'comparatorVersion', 'expiresAt', 'issuedAt', 'keyVersion', 'limit',
  'policyRevision', 'principalId', 'purpose', 'sort', 'v'] as const;
const AFTER_KEYS = ['id', 'updatedAt'] as const;
const ISSUE_AFTER_KEYS = ['editionOrdinal', 'id', 'publishedAt'] as const;

export interface ReportsCursorConfig {
  readonly active: ReportsCursorKey | { readonly id: string; readonly secret: string };
  readonly retained?: readonly (
    RetainedReportsCursorKey
    | { readonly id: string; readonly secret: string; readonly lastIssuedAt: string; readonly retainUntil: string }
  )[];
}

function cursorCodecKeys(config: ReportsCursorConfig): {
  readonly current: { readonly id: string; readonly key: string };
  readonly previous?: readonly { readonly id: string; readonly key: string; readonly lastIssuedAt: string; readonly retainUntil: string }[];
} {
  const current = 'key' in config.active
    ? { id: config.active.id, key: config.active.key }
    : { id: config.active.id, key: config.active.secret };
  const previous = config.retained?.map((key) => ({
    id: key.id,
    key: 'key' in key ? key.key : key.secret,
    lastIssuedAt: key.lastIssuedAt,
    retainUntil: key.retainUntil,
  }));
  return previous === undefined ? { current } : { current, previous };
}

function cursorCodecMessages(prefix: string) {
  return {
    invalidKey: `invalid ${prefix} cursor key`,
    tooManyKeys: `${prefix} cursor supports at most 8 retained keys`,
    uniqueKeys: `${prefix} cursor keys must be unique`,
    retention: `${prefix} cursor retained key lifetime must cover cursor TTL`,
  } as const;
}

export function createReportsCursorSigner(config: ReportsCursorConfig): ReportsCursorSigner {
  const codec = createKeyedCursorCodec<ReportsCursorPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: REPORTS_CURSOR_TTL_MS,
    keys: cursorCodecKeys(config),
    invalid: () => new ReportsCursorError(),
    validate: validateReportsCursorPayload,
    messages: cursorCodecMessages('reports'),
    maxPreviousKeys: 8,
    maxTokenLength: 4096,
  });
  return Object.freeze({
    sign: (payload: UnsignedReportsCursorPayload) => codec.sign(payload),
    seal: (payload: UnsignedReportsCursorPayload) => codec.seal(payload),
    verify: (token: string, now: Date) => codec.verify(token, now),
    destroy: () => codec.destroy(),
  });
}

/** HMAC signer for the publishedAt/editionOrdinal issue-list comparator. */
export function createReportsIssueCursorSigner(config: ReportsCursorConfig): ReportsIssueCursorSigner {
  const codec = createKeyedCursorCodec<ReportsIssueCursorPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: REPORTS_CURSOR_TTL_MS,
    keys: cursorCodecKeys(config),
    invalid: () => new ReportsCursorError(),
    validate: validateReportsIssueCursorPayload,
    messages: cursorCodecMessages('reports issue'),
    maxPreviousKeys: 8,
    maxTokenLength: 4096,
  });
  return Object.freeze({
    sign: (payload: UnsignedReportsIssueCursorPayload) => codec.sign(payload),
    seal: (payload: UnsignedReportsIssueCursorPayload) => codec.seal(payload),
    verify: (token: string, now: Date) => codec.verify(token, now),
    destroy: () => codec.destroy(),
  });
}

export function validateReportsCursorPayload(value: unknown): ReportsCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)) throw new Error();
  const record = value as Record<string, unknown>;
  const after = record.after as Record<string, unknown>;
  if (record.v !== 1 || record.purpose !== REPORTS_CURSOR_PURPOSE || record.sort !== REPORTS_CURSOR_SORT
      || record.comparatorVersion !== REPORTS_CURSOR_COMPARATOR_VERSION
      || typeof record.principalId !== 'string' || record.principalId.length < 1 || record.principalId.length > 256
      || record.principalId.trim() !== record.principalId || typeof record.policyRevision !== 'string' || record.policyRevision.length < 1
      || typeof record.keyVersion !== 'string' || typeof after.id !== 'string' || after.id.length < 1
      || after.id.length > 256 || after.id.trim() !== after.id || typeof after.updatedAt !== 'string'
      || typeof record.limit !== 'number' || !Number.isInteger(record.limit)
      || typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') throw new Error();
  assertPageLimit(record.limit as number, 100);
  parseCursorTimestamp(after.updatedAt, 'rfc3339-millis');
  parseCursorTimestamp(record.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(record.expiresAt, 'rfc3339-millis');
  return record as unknown as ReportsCursorPayload;
}

export function validateReportsIssueCursorPayload(value: unknown): ReportsIssueCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, ISSUE_AFTER_KEYS)) throw new Error();
  const record = value as Record<string, unknown>;
  const after = record.after as Record<string, unknown>;
  if (record.v !== 1 || record.purpose !== REPORTS_ISSUE_CURSOR_PURPOSE
      || record.sort !== REPORTS_ISSUE_CURSOR_SORT
      || record.comparatorVersion !== REPORTS_ISSUE_CURSOR_COMPARATOR_VERSION
      || typeof record.principalId !== 'string' || record.principalId.length < 1 || record.principalId.length > 256
      || record.principalId.trim() !== record.principalId || typeof record.policyRevision !== 'string'
      || record.policyRevision.length < 1 || record.policyRevision.length > 256
      || typeof record.keyVersion !== 'string' || typeof after.id !== 'string'
      || after.id.length < 1 || after.id.length > 256 || after.id.trim() !== after.id
      || typeof after.publishedAt !== 'string' || typeof after.editionOrdinal !== 'number'
      || !Number.isSafeInteger(after.editionOrdinal) || after.editionOrdinal < 1
      || typeof record.limit !== 'number' || !Number.isInteger(record.limit)
      || typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') throw new Error();
  assertPageLimit(record.limit as number, 100);
  parseCursorTimestamp(after.publishedAt, 'rfc3339-millis');
  parseCursorTimestamp(record.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(record.expiresAt, 'rfc3339-millis');
  return record as unknown as ReportsIssueCursorPayload;
}
