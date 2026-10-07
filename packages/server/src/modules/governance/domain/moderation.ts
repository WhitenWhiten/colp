export const GOVERNANCE_EVIDENCE_MAX_BYTES = 65_536;
export const GOVERNANCE_EVIDENCE_RETENTION_DAYS = 365;
export const GOVERNANCE_REPORT_RATE_MAX = 10;
export const GOVERNANCE_REPORT_RATE_WINDOW_MS = 3_600_000;
export const GOVERNANCE_PAGE_MAX_BYTES = 65_536;
export const GOVERNANCE_PAGE_MAX_LIMIT = 100;
export const GOVERNANCE_PAGE_DEFAULT_LIMIT = 20;
export const GOVERNANCE_CURSOR_TTL_MS = 900_000;
export const GOVERNANCE_CURSOR_MAX_LENGTH = 2_048;
export const GOVERNANCE_DESCRIPTION_MAX = 4_000;
export const GOVERNANCE_PUBLIC_RESOLUTION_MAX = 2_000;
export const GOVERNANCE_INTERNAL_NOTE_MAX = 4_000;
export const GOVERNANCE_EVIDENCE_TITLE_MAX = 512;
export const GOVERNANCE_EVIDENCE_TEXT_MAX = 20_000;
export const GOVERNANCE_EVIDENCE_SOURCE_URL_MAX = 8_192;
export const GOVERNANCE_REASON_MAX = 2_000;
export const COMMENTS_IMPLEMENTED = true;

export const MODERATION_CATEGORIES = Object.freeze([
  'spam', 'harassment', 'illegal_content', 'privacy', 'other',
] as const);
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export const MODERATION_CASE_STATUSES = Object.freeze([
  'submitted', 'in_review', 'resolved', 'dismissed',
] as const);
export type ModerationCaseStatus = (typeof MODERATION_CASE_STATUSES)[number];

export const OPEN_MODERATION_STATUSES = Object.freeze(['submitted', 'in_review'] as const);
export type OpenModerationStatus = (typeof OPEN_MODERATION_STATUSES)[number];

export const MODERATION_ROLES = Object.freeze(['reviewer', 'moderator'] as const);
export type ModerationRole = (typeof MODERATION_ROLES)[number];

export const MODERATION_TARGET_KINDS = Object.freeze([
  'collection', 'bookmark', 'digest_series', 'digest_edition', 'account', 'comment',
] as const);
export type ModerationTargetKind = (typeof MODERATION_TARGET_KINDS)[number];

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const SOURCE_REVISION = /^[A-Za-z0-9._~-]{1,128}$/u;

export class GovernanceModerationError extends Error {
  readonly code:
    | 'invalid_request'
    | 'invalid_query'
    | 'invalid_cursor'
    | 'snapshot_expired'
    | 'resource_not_found'
    | 'insufficient_permission'
    | 'revision_conflict';
  readonly outcome?: 'conceal' | 'deny';

  constructor(
    code: GovernanceModerationError['code'],
    message: string,
    outcome?: 'conceal' | 'deny',
  ) {
    super(message);
    this.name = 'GovernanceModerationError';
    this.code = code;
    if (outcome !== undefined) this.outcome = outcome;
  }
}

export type GovernanceTarget =
  | { readonly kind: 'collection'; readonly id: string }
  | { readonly kind: 'bookmark'; readonly id: string; readonly collectionId: string }
  | { readonly kind: 'digest_series'; readonly id: string }
  | { readonly kind: 'digest_edition'; readonly id: string; readonly seriesId: string }
  | { readonly kind: 'account'; readonly id: string }
  | { readonly kind: 'comment'; readonly id: string };

export interface ReportInput {
  readonly target: GovernanceTarget;
  readonly category: ModerationCategory;
  readonly description: string;
}

export interface MyCase {
  readonly id: string;
  readonly target: GovernanceTarget;
  readonly category: ModerationCategory;
  readonly status: ModerationCaseStatus;
  readonly publicResolution: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OfficialCase {
  readonly case: MyCase;
  readonly reporterAccountId: string;
  readonly description: string;
  readonly assignedToAccountId: string | null;
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly internalNote: string | null;
}

export interface Evidence {
  readonly id: string;
  readonly caseId: string;
  readonly target: GovernanceTarget;
  readonly capturedAt: string;
  readonly sourceRevision: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly sourceUrl: string | null;
  readonly truncated: boolean;
}

export interface EvidenceCapture {
  readonly target: GovernanceTarget;
  readonly capturedAt: string;
  readonly sourceRevision: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly sourceUrl: string | null;
}

export function isOpenModerationStatus(status: string): status is OpenModerationStatus {
  return status === 'submitted' || status === 'in_review';
}

export function hasOfficialRead(roles: ReadonlySet<ModerationRole>): boolean {
  return roles.has('reviewer') || roles.has('moderator');
}

export function governanceTimestamp(value: Date): string {
  return value.toISOString();
}

export function parseModerationCaseStatus(
  value: unknown,
  code: 'invalid_request' | 'invalid_query' = 'invalid_query',
): ModerationCaseStatus {
  if (typeof value !== 'string' || !MODERATION_CASE_STATUSES.includes(value as ModerationCaseStatus)) {
    throw new GovernanceModerationError(code, 'status is invalid');
  }
  return value as ModerationCaseStatus;
}

export function parseModerationLimit(value: unknown): number {
  if (value === undefined) return GOVERNANCE_PAGE_DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new GovernanceModerationError('invalid_query', 'limit is invalid');
  }
  const parsed = Number(value);
  if (parsed > GOVERNANCE_PAGE_MAX_LIMIT) {
    throw new GovernanceModerationError('invalid_query', 'limit is invalid');
  }
  return parsed;
}

export function parseOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new GovernanceModerationError('invalid_request', `${field} is invalid`);
  }
  return value;
}

export function parseQueryOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new GovernanceModerationError('invalid_query', `${field} is invalid`);
  }
  return value;
}

export function parseGovernanceCursor(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > GOVERNANCE_CURSOR_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  return value;
}

export function parseReportInput(body: unknown): ReportInput {
  const record = requireClosedObject(body, 'invalid_request');
  assertExactKeys(record, ['target', 'category', 'description']);
  const target = parseGovernanceTarget(record.target);
  if (target.kind === 'comment' && !COMMENTS_IMPLEMENTED) {
    throw new GovernanceModerationError('invalid_request', 'comment targets are not supported');
  }
  if (typeof record.category !== 'string'
    || !MODERATION_CATEGORIES.includes(record.category as ModerationCategory)) {
    throw new GovernanceModerationError('invalid_request', 'category is invalid');
  }
  if (typeof record.description !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'description is invalid');
  }
  const description = normalizeUserText(record.description);
  const length = codePointLength(description);
  if (length < 1 || length > GOVERNANCE_DESCRIPTION_MAX) {
    throw new GovernanceModerationError('invalid_request', 'description is invalid');
  }
  return Object.freeze({
    target,
    category: record.category as ModerationCategory,
    description,
  });
}

export function parseGovernanceTarget(value: unknown): GovernanceTarget {
  const record = requireClosedObject(value, 'invalid_request');
  if (typeof record.kind !== 'string'
    || !MODERATION_TARGET_KINDS.includes(record.kind as ModerationTargetKind)) {
    throw new GovernanceModerationError('invalid_request', 'target.kind is invalid');
  }
  const kind = record.kind as ModerationTargetKind;
  const id = requireOpaque(record.id, 'target.id');
  if (kind === 'collection' || kind === 'digest_series' || kind === 'account' || kind === 'comment') {
    assertExactKeys(record, ['kind', 'id']);
    return Object.freeze({ kind, id });
  }
  if (kind === 'bookmark') {
    assertExactKeys(record, ['kind', 'id', 'collectionId']);
    return Object.freeze({ kind, id, collectionId: requireOpaque(record.collectionId, 'target.collectionId') });
  }
  assertExactKeys(record, ['kind', 'id', 'seriesId']);
  return Object.freeze({ kind, id, seriesId: requireOpaque(record.seriesId, 'target.seriesId') });
}

export function targetFingerprint(target: GovernanceTarget): string {
  if (target.kind === 'bookmark') {
    return `bookmark:${target.collectionId}:${target.id}`;
  }
  if (target.kind === 'digest_edition') {
    return `digest_edition:${target.seriesId}:${target.id}`;
  }
  return `${target.kind}:${target.id}`;
}

export function myCaseFrom(record: {
  readonly id: string;
  readonly target: GovernanceTarget;
  readonly category: ModerationCategory;
  readonly status: ModerationCaseStatus;
  readonly publicResolution: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): MyCase {
  return Object.freeze({
    id: record.id,
    target: record.target,
    category: record.category,
    status: record.status,
    publicResolution: record.publicResolution,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function officialCaseFrom(record: {
  readonly case: MyCase;
  readonly reporterAccountId: string;
  readonly description: string;
  readonly assignedToAccountId: string | null;
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly internalNote: string | null;
}): OfficialCase {
  return Object.freeze({
    case: record.case,
    reporterAccountId: record.reporterAccountId,
    description: record.description,
    assignedToAccountId: record.assignedToAccountId,
    evidenceIds: Object.freeze([...record.evidenceIds]),
    actionIds: Object.freeze([...record.actionIds]),
    internalNote: record.internalNote,
  });
}

export function captureEvidence(
  input: EvidenceCapture,
  ids: { readonly id: string; readonly caseId: string },
): Evidence {
  const title = clampNullableText(input.title, GOVERNANCE_EVIDENCE_TITLE_MAX);
  const text = clampNullableText(input.text, GOVERNANCE_EVIDENCE_TEXT_MAX);
  const sourceUrl = clampNullableText(input.sourceUrl, GOVERNANCE_EVIDENCE_SOURCE_URL_MAX);
  const sourceRevision = input.sourceRevision === null || input.sourceRevision === undefined
    ? null
    : (typeof input.sourceRevision === 'string' && SOURCE_REVISION.test(input.sourceRevision)
      ? input.sourceRevision
      : null);
  let truncated = title !== input.title || text !== input.text || sourceUrl !== input.sourceUrl;
  let nextTitle = title;
  let nextText = text;
  let record = evidenceRecord({
    id: ids.id,
    caseId: ids.caseId,
    target: input.target,
    capturedAt: input.capturedAt,
    sourceRevision,
    title: nextTitle,
    text: nextText,
    sourceUrl,
    truncated,
  });
  while (utf8Bytes(JSON.stringify(record)) > GOVERNANCE_EVIDENCE_MAX_BYTES) {
    truncated = true;
    if (nextText !== null && nextText.length > 0) {
      nextText = shrinkUtf8(nextText, Math.max(0, utf8Bytes(nextText) - 64));
      if (nextText.length === 0) nextText = null;
    } else if (nextTitle !== null && nextTitle.length > 0) {
      nextTitle = shrinkUtf8(nextTitle, Math.max(0, utf8Bytes(nextTitle) - 32));
      if (nextTitle.length === 0) nextTitle = null;
    } else {
      throw new GovernanceModerationError('invalid_request', 'evidence snapshot exceeds the capture budget');
    }
    record = evidenceRecord({
      id: ids.id,
      caseId: ids.caseId,
      target: input.target,
      capturedAt: input.capturedAt,
      sourceRevision,
      title: nextTitle,
      text: nextText,
      sourceUrl,
      truncated,
    });
  }
  return record;
}

export function fillGovernancePage<T>(
  eligible: readonly T[],
  limit: number,
  nextCursorFor: (item: T) => string,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const items: T[] = [];
  let overflow: T | undefined;
  for (const item of eligible) {
    if (items.length >= limit) {
      overflow = item;
      break;
    }
    const trial = [...items, item];
    const trialCursor = nextCursorFor(item);
    const encoded = JSON.stringify({
      items: trial,
      nextCursor: trialCursor.padEnd(GOVERNANCE_CURSOR_MAX_LENGTH, 'A'),
    });
    if (utf8Bytes(encoded) > GOVERNANCE_PAGE_MAX_BYTES) {
      if (items.length === 0) {
        throw new GovernanceModerationError('invalid_request', 'page item exceeds the output budget');
      }
      overflow = item;
      break;
    }
    items.push(item);
  }
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: overflow === undefined ? null : nextCursorFor(overflow),
  });
}

function evidenceRecord(value: Evidence): Evidence {
  return Object.freeze({
    id: value.id,
    caseId: value.caseId,
    target: value.target,
    capturedAt: value.capturedAt,
    sourceRevision: value.sourceRevision,
    title: value.title,
    text: value.text,
    sourceUrl: value.sourceUrl,
    truncated: value.truncated,
  });
}

function requireClosedObject(
  value: unknown,
  code: 'invalid_request' | 'invalid_query',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GovernanceModerationError(code, 'request object is invalid');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new GovernanceModerationError('invalid_request', `unknown field ${key}`);
    }
    if (record[key] === undefined) {
      throw new GovernanceModerationError('invalid_request', `${key} is invalid`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) {
      throw new GovernanceModerationError('invalid_request', `${key} is required`);
    }
    if (record[key] === null && key !== 'language') {
      throw new GovernanceModerationError('invalid_request', `${key} is invalid`);
    }
  }
}

function requireOpaque(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new GovernanceModerationError('invalid_request', `${field} is invalid`);
  }
  return value;
}

function normalizeUserText(value: string): string {
  return value.trim().normalize('NFC');
}

function codePointLength(value: string): number {
  return [...value].length;
}

function clampNullableText(value: string | null, maxCodePoints: number): string | null {
  if (value === null) return null;
  const normalized = normalizeUserText(value);
  if (normalized.length === 0) return null;
  if (codePointLength(normalized) <= maxCodePoints) return normalized;
  return [...normalized].slice(0, maxCodePoints).join('');
}

function shrinkUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let next = '';
  for (const point of value) {
    const candidate = next + point;
    if (utf8Bytes(candidate) > maxBytes) break;
    next = candidate;
  }
  return next;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
