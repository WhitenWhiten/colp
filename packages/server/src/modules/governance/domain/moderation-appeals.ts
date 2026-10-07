import {
  GOVERNANCE_DESCRIPTION_MAX,
  GovernanceModerationError,
  parseOpaqueId,
} from './moderation.js';

export const GOVERNANCE_APPEAL_RATE_MAX = 10;
export const GOVERNANCE_APPEAL_RATE_WINDOW_MS = 86_400_000;
export const GOVERNANCE_APPEAL_RESOLUTION_MAX = 2_000;

export const MODERATION_APPEAL_STATUSES = Object.freeze([
  'submitted', 'upheld', 'rejected',
] as const);
export type ModerationAppealStatus = (typeof MODERATION_APPEAL_STATUSES)[number];

export const MODERATION_APPEAL_DECISIONS = Object.freeze(['uphold', 'reject'] as const);
export type ModerationAppealDecisionKind = (typeof MODERATION_APPEAL_DECISIONS)[number];

export interface AppealInput {
  readonly actionId: string;
  readonly description: string;
}

export interface AppealDecisionInput {
  readonly decision: ModerationAppealDecisionKind;
  readonly resolution: string;
}

export interface Appeal {
  readonly id: string;
  readonly actionId: string;
  readonly description: string;
  readonly status: ModerationAppealStatus;
  readonly resolution: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAppeal(record: Appeal): Appeal {
  return Object.freeze({
    id: record.id,
    actionId: record.actionId,
    description: record.description,
    status: record.status,
    resolution: record.resolution,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function parseAppealInput(body: unknown): AppealInput {
  const record = requireClosedObject(body);
  assertExactKeys(record, ['actionId', 'description']);
  const actionId = parseOpaqueId(record.actionId, 'actionId');
  if (typeof record.description !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'description is invalid');
  }
  const description = normalizeUserText(record.description);
  const length = codePointLength(description);
  if (length < 1 || length > GOVERNANCE_DESCRIPTION_MAX) {
    throw new GovernanceModerationError('invalid_request', 'description is invalid');
  }
  return Object.freeze({ actionId, description });
}

export function parseAppealDecision(body: unknown): AppealDecisionInput {
  const record = requireClosedObject(body);
  assertExactKeys(record, ['decision', 'resolution']);
  if (typeof record.decision !== 'string'
    || !MODERATION_APPEAL_DECISIONS.includes(record.decision as ModerationAppealDecisionKind)) {
    throw new GovernanceModerationError('invalid_request', 'decision is invalid');
  }
  if (typeof record.resolution !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'resolution is invalid');
  }
  const resolution = normalizeUserText(record.resolution);
  const length = codePointLength(resolution);
  if (length < 1 || length > GOVERNANCE_APPEAL_RESOLUTION_MAX) {
    throw new GovernanceModerationError('invalid_request', 'resolution is invalid');
  }
  return Object.freeze({
    decision: record.decision as ModerationAppealDecisionKind,
    resolution,
  });
}

export function parseAppealStatus(
  value: unknown,
  code: 'invalid_request' | 'invalid_query' = 'invalid_query',
): ModerationAppealStatus {
  if (typeof value !== 'string' || !MODERATION_APPEAL_STATUSES.includes(value as ModerationAppealStatus)) {
    throw new GovernanceModerationError(code, 'status is invalid');
  }
  return value as ModerationAppealStatus;
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

function normalizeUserText(value: string): string {
  return value.trim().normalize('NFC');
}

function codePointLength(value: string): number {
  return [...value].length;
}
