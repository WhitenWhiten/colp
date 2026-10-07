import {
  COMMENTS_IMPLEMENTED,
  GOVERNANCE_INTERNAL_NOTE_MAX,
  GOVERNANCE_PUBLIC_RESOLUTION_MAX,
  GOVERNANCE_REASON_MAX,
  GovernanceModerationError,
  parseGovernanceTarget,
  parseOpaqueId,
  targetFingerprint,
  type GovernanceTarget,
  type ModerationCaseStatus,
} from './moderation.js';

export const GOVERNANCE_ACTION_RATE_MAX = 60;
export const GOVERNANCE_ACTION_RATE_WINDOW_MS = 60_000;
export const GOVERNANCE_OUTBOX_BATCH_SIZE = 100;
export const GOVERNANCE_OUTBOX_LEASE_SECONDS = 30;
export const GOVERNANCE_OUTBOX_MAX_ATTEMPTS = 10;
export const GOVERNANCE_OUTBOX_BACKOFF_SECONDS = Object.freeze([1, 2, 4, 8, 16, 32, 60] as const);

export const MODERATION_ACTION_TYPES = Object.freeze([
  'delist',
  'hide_public',
  'restrict_interaction',
  'restrict_publication',
  'hide_comment',
  'lock_comments',
] as const);
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

export const MODERATION_ACTION_STATES = Object.freeze(['active', 'revoked'] as const);
export type ModerationActionState = (typeof MODERATION_ACTION_STATES)[number];

export const ENABLED_COLLECTION_ACTIONS = Object.freeze(['delist', 'hide_public', 'lock_comments'] as const);
export type EnabledCollectionAction = (typeof ENABLED_COLLECTION_ACTIONS)[number];
export const ENABLED_BOOKMARK_ACTIONS = Object.freeze(['delist', 'hide_public'] as const);
export type EnabledBookmarkAction = (typeof ENABLED_BOOKMARK_ACTIONS)[number];
export const ENABLED_DIGEST_ACTIONS = Object.freeze(['delist', 'hide_public'] as const);
export type EnabledDigestAction = (typeof ENABLED_DIGEST_ACTIONS)[number];
export const ENABLED_ACCOUNT_ACTIONS = Object.freeze(['restrict_interaction', 'restrict_publication'] as const);
export type EnabledAccountAction = (typeof ENABLED_ACCOUNT_ACTIONS)[number];

export interface ActionInput {
  readonly caseId: string;
  readonly target: GovernanceTarget;
  readonly action: ModerationActionType;
  readonly reason: string;
}

export interface Action {
  readonly id: string;
  readonly caseId: string;
  readonly target: GovernanceTarget;
  readonly action: ModerationActionType;
  readonly reason: string;
  readonly actorAccountId: string;
  readonly state: ModerationActionState;
  readonly revision: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

export interface MyAction {
  readonly id: string;
  readonly target: GovernanceTarget;
  readonly action: ModerationActionType;
  readonly reason: string;
  readonly state: ModerationActionState;
  readonly revision: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

export interface CasePatch {
  readonly status?: Exclude<ModerationCaseStatus, 'submitted'>;
  readonly assignedToAccountId?: string | null;
  readonly publicResolution?: string | null;
  readonly internalNote?: string | null;
}

export interface CollectionControlDecision {
  readonly hidePublic: boolean;
  readonly delisted: boolean;
}

export interface AccountControlDecision {
  readonly restrictInteraction: boolean;
  readonly restrictPublication: boolean;
}

export function hasOfficialWrite(roles: ReadonlySet<'reviewer' | 'moderator'>): boolean {
  return roles.has('moderator');
}

export function isEnabledActionPair(
  target: GovernanceTarget,
  action: ModerationActionType,
): boolean {
  if (target.kind === 'account') {
    return action === 'restrict_interaction' || action === 'restrict_publication';
  }
  if (target.kind === 'comment') {
    return COMMENTS_IMPLEMENTED && action === 'hide_comment';
  }
  return (target.kind === 'collection' || target.kind === 'bookmark'
    || target.kind === 'digest_series' || target.kind === 'digest_edition')
    && (action === 'delist' || action === 'hide_public'
      || (COMMENTS_IMPLEMENTED && action === 'lock_comments'));
}

export function targetsMatch(left: GovernanceTarget, right: GovernanceTarget): boolean {
  return targetFingerprint(left) === targetFingerprint(right);
}

export function composeCollectionDecision(
  actions: readonly { readonly action: string; readonly state: string }[],
): CollectionControlDecision {
  let hidePublic = false;
  let delisted = false;
  for (const record of actions) {
    if (record.state !== 'active') continue;
    if (record.action === 'hide_public') hidePublic = true;
    if (record.action === 'delist') delisted = true;
  }
  return Object.freeze({ hidePublic, delisted: delisted || hidePublic });
}

export function composeAccountDecision(
  actions: readonly { readonly action: string; readonly state: string }[],
): AccountControlDecision {
  let restrictInteraction = false;
  let restrictPublication = false;
  for (const record of actions) {
    if (record.state !== 'active') continue;
    if (record.action === 'restrict_interaction') restrictInteraction = true;
    if (record.action === 'restrict_publication') restrictPublication = true;
  }
  return Object.freeze({ restrictInteraction, restrictPublication });
}

export function toAction(record: Action): Action {
  return Object.freeze({
    id: record.id,
    caseId: record.caseId,
    target: record.target,
    action: record.action,
    reason: record.reason,
    actorAccountId: record.actorAccountId,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
  });
}

export function toMyAction(record: Action): MyAction {
  return Object.freeze({
    id: record.id,
    target: record.target,
    action: record.action,
    reason: record.reason,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
  });
}

export function nextGovernanceRevision(current: string): string {
  return String(BigInt(current) + 1n);
}

export function parseActionInput(body: unknown): ActionInput {
  const record = requireClosedObject(body);
  assertExactKeys(record, ['caseId', 'target', 'action', 'reason']);
  const caseId = parseOpaqueId(record.caseId, 'caseId');
  const target = parseGovernanceTarget(record.target);
  if (typeof record.action !== 'string'
    || !MODERATION_ACTION_TYPES.includes(record.action as ModerationActionType)) {
    throw new GovernanceModerationError('invalid_request', 'action is invalid');
  }
  const action = record.action as ModerationActionType;
  assertActionTargetPair(target, action);
  if (typeof record.reason !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  const reason = normalizeUserText(record.reason);
  const length = codePointLength(reason);
  if (length < 1 || length > GOVERNANCE_REASON_MAX) {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  return Object.freeze({ caseId, target, action, reason });
}

export function parseRevokeReason(body: unknown): string {
  const record = requireClosedObject(body);
  assertExactKeys(record, ['reason']);
  if (typeof record.reason !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  const reason = normalizeUserText(record.reason);
  const length = codePointLength(reason);
  if (length < 1 || length > GOVERNANCE_REASON_MAX) {
    throw new GovernanceModerationError('invalid_request', 'reason is invalid');
  }
  return reason;
}

export function parseCasePatch(body: unknown): CasePatch {
  const record = requireClosedObject(body);
  const allowed = ['status', 'assignedToAccountId', 'publicResolution', 'internalNote'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new GovernanceModerationError('invalid_request', `unknown field ${key}`);
    }
    if (record[key] === undefined) {
      throw new GovernanceModerationError('invalid_request', `${key} is invalid`);
    }
  }
  const patch: {
    status?: Exclude<ModerationCaseStatus, 'submitted'>;
    assignedToAccountId?: string | null;
    publicResolution?: string | null;
    internalNote?: string | null;
  } = {};
  if (Object.hasOwn(record, 'status')) {
    if (record.status !== 'in_review' && record.status !== 'resolved' && record.status !== 'dismissed') {
      throw new GovernanceModerationError('invalid_request', 'status is invalid');
    }
    patch.status = record.status;
  }
  if (Object.hasOwn(record, 'assignedToAccountId')) {
    if (record.assignedToAccountId === null) {
      patch.assignedToAccountId = null;
    } else {
      patch.assignedToAccountId = parseOpaqueId(record.assignedToAccountId, 'assignedToAccountId');
    }
  }
  if (Object.hasOwn(record, 'publicResolution')) {
    patch.publicResolution = parseNullableText(
      record.publicResolution,
      'publicResolution',
      GOVERNANCE_PUBLIC_RESOLUTION_MAX,
    );
  }
  if (Object.hasOwn(record, 'internalNote')) {
    patch.internalNote = parseNullableText(
      record.internalNote,
      'internalNote',
      GOVERNANCE_INTERNAL_NOTE_MAX,
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new GovernanceModerationError('invalid_request', 'patch must include at least one field');
  }
  return Object.freeze(patch);
}

export function applyCaseStatusTransition(
  current: ModerationCaseStatus,
  next: Exclude<ModerationCaseStatus, 'submitted'> | undefined,
): ModerationCaseStatus {
  if (next === undefined || next === current) return current;
  if (current === 'resolved' || current === 'dismissed') {
    throw new GovernanceModerationError('invalid_request', 'case status is terminal');
  }
  if (current === 'submitted' && next === 'in_review') return next;
  if (current === 'in_review' && (next === 'resolved' || next === 'dismissed')) return next;
  throw new GovernanceModerationError('invalid_request', 'status transition is invalid');
}

export function requireClosingResolution(
  status: ModerationCaseStatus,
  publicResolution: string | null,
): void {
  if ((status === 'resolved' || status === 'dismissed')
    && (publicResolution === null || publicResolution.length < 1)) {
    throw new GovernanceModerationError('invalid_request', 'closing a case requires publicResolution');
  }
}

function assertActionTargetPair(target: GovernanceTarget, action: ModerationActionType): void {
  if (action === 'hide_comment') {
    if (target.kind !== 'comment' || !COMMENTS_IMPLEMENTED) {
      throw new GovernanceModerationError('invalid_request', 'action target pair is invalid');
    }
    return;
  }
  if (action === 'restrict_interaction' || action === 'restrict_publication') {
    if (target.kind !== 'account') {
      throw new GovernanceModerationError('invalid_request', 'action target pair is invalid');
    }
    return;
  }
  if (action === 'delist' || action === 'hide_public' || action === 'lock_comments') {
    if (target.kind !== 'collection' && target.kind !== 'bookmark'
      && target.kind !== 'digest_series' && target.kind !== 'digest_edition') {
      throw new GovernanceModerationError('invalid_request', 'action target pair is invalid');
    }
    if (action === 'lock_comments' && !COMMENTS_IMPLEMENTED) {
      throw new GovernanceModerationError('invalid_request', 'action target pair is invalid');
    }
    return;
  }
  throw new GovernanceModerationError('invalid_request', 'action target pair is invalid');
}

function requireClosedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GovernanceModerationError('invalid_request', 'request object is invalid');
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
    if (record[key] === null) {
      throw new GovernanceModerationError('invalid_request', `${key} is invalid`);
    }
  }
}

function parseNullableText(value: unknown, field: string, maxCodePoints: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new GovernanceModerationError('invalid_request', `${field} is invalid`);
  }
  const normalized = normalizeUserText(value);
  const length = codePointLength(normalized);
  if (length < 1 || length > maxCodePoints) {
    throw new GovernanceModerationError('invalid_request', `${field} is invalid`);
  }
  return normalized;
}

function normalizeUserText(value: string): string {
  return value.trim().normalize('NFC');
}

function codePointLength(value: string): number {
  return [...value].length;
}
