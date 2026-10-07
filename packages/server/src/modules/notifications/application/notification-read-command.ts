import { createHash } from 'node:crypto';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';

export const NOTIFICATION_READ_COMMAND_CONTRACT_VERSION = '1.0.0';
export const NOTIFICATION_READ_COMMAND_SCOPE = 'notification:read-state:v1';
export const NOTIFICATION_READ_BULK_MAX_ITEMS = 100;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type NotificationReadCommandMode = 'one' | 'bulk';
export type NotificationReadCommandErrorCode = 'invalid_request' | 'stale_state';
export class NotificationReadCommandError extends Error {
  constructor(readonly code: NotificationReadCommandErrorCode, message: string) {
    super(message); this.name = 'NotificationReadCommandError';
  }
}

export interface MarkNotificationReadInput {
  readonly principalId: string;
  readonly notificationId: string;
  readonly expectedStateRevision: bigint;
  readonly commandId: string;
}
export interface MarkNotificationsReadInput {
  readonly principalId: string;
  readonly notificationIds: readonly string[];
  readonly commandId: string;
}
export type NotificationReadAuthorityOneResult =
  | { readonly kind: 'marked'; readonly stateRevision: bigint; readonly readAt: Date }
  | { readonly kind: 'already_read'; readonly stateRevision: bigint; readonly readAt: Date }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stale' };
export interface NotificationReadAuthorityBulkResult {
  readonly requestedCount: number; readonly markedCount: number;
}
export interface NotificationReadAuditEvent {
  readonly principalId: string; readonly mode: NotificationReadCommandMode;
  readonly requestedCount: number; readonly changedCount: number;
  readonly outcome: 'marked' | 'already_read' | 'not_found' | 'completed';
  readonly createdAt: Date;
}
export interface NotificationReadCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly authority: {
    markOne(input: Omit<MarkNotificationReadInput, 'commandId'>):
      Promise<NotificationReadAuthorityOneResult>;
    markMany(input: Omit<MarkNotificationsReadInput, 'commandId'>):
      Promise<NotificationReadAuthorityBulkResult>;
  };
  readonly audit: { append(event: NotificationReadAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}
type ClaimResult =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };
export type MarkNotificationReadResult =
  | { readonly kind: 'succeeded'; readonly outcome: 'marked' | 'already_read';
      readonly notificationId: string; readonly state: 'read'; readonly stateRevision: bigint;
      readonly readAt: string; readonly changed: boolean }
  | { readonly kind: 'succeeded'; readonly outcome: 'not_found'; readonly changed: false }
  | ClaimResult;
export type MarkNotificationsReadResult =
  | { readonly kind: 'succeeded'; readonly requestedCount: number; readonly markedCount: number }
  | ClaimResult;

export function notificationReadCommandFingerprint(mode: 'one', input: MarkNotificationReadInput): string;
export function notificationReadCommandFingerprint(mode: 'bulk', input: MarkNotificationsReadInput): string;
export function notificationReadCommandFingerprint(mode: NotificationReadCommandMode,
  input: MarkNotificationReadInput | MarkNotificationsReadInput): string {
  const normalized = mode === 'one' ? validateOne(input as MarkNotificationReadInput)
    : validateBulk(input as MarkNotificationsReadInput);
  return createHash('sha256').update(canonicalJson({
    mode, principalId: normalized.principalId,
    ...(mode === 'one' ? { notificationId: (normalized as MarkNotificationReadInput).notificationId,
      expectedStateRevision: (normalized as MarkNotificationReadInput).expectedStateRevision.toString() }
      : { notificationIds: (normalized as MarkNotificationsReadInput).notificationIds }),
    contractVersion: NOTIFICATION_READ_COMMAND_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export async function markNotificationRead(ports: NotificationReadCommandPorts,
  input: MarkNotificationReadInput): Promise<MarkNotificationReadResult> {
  const value = validateOne(input); const fingerprint = notificationReadCommandFingerprint('one', value);
  const binding = { principalId: value.principalId, commandScope: NOTIFICATION_READ_COMMAND_SCOPE,
    commandId: value.commandId };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const authority = await ports.authority.markOne({ principalId: value.principalId,
    notificationId: value.notificationId, expectedStateRevision: value.expectedStateRevision });
  if (authority.kind === 'stale') {
    throw new NotificationReadCommandError('stale_state', 'Notification read state changed.');
  }
  const now = await validClock(ports); const outcome = authority.kind;
  await ports.audit.append({ principalId: value.principalId, mode: 'one', requestedCount: 1,
    changedCount: outcome === 'marked' ? 1 : 0, outcome, createdAt: now });
  const result: Extract<MarkNotificationReadResult, { kind: 'succeeded' }> =
    authority.kind === 'not_found' ? { kind: 'succeeded', outcome: 'not_found', changed: false }
      : { kind: 'succeeded', outcome: authority.kind, notificationId: value.notificationId,
        state: 'read', stateRevision: authority.stateRevision,
        readAt: authority.readAt.toISOString(), changed: authority.kind === 'marked' };
  await ports.receipts.complete(binding, fingerprint, productResult(result,
    authority.kind === 'not_found' ? undefined : value.notificationId));
  return result;
}

export async function markNotificationsRead(ports: NotificationReadCommandPorts,
  input: MarkNotificationsReadInput): Promise<MarkNotificationsReadResult> {
  const value = validateBulk(input); const fingerprint = notificationReadCommandFingerprint('bulk', value);
  const binding = { principalId: value.principalId, commandScope: NOTIFICATION_READ_COMMAND_SCOPE,
    commandId: value.commandId };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const authority = await ports.authority.markMany({ principalId: value.principalId,
    notificationIds: value.notificationIds });
  if (authority.requestedCount !== value.notificationIds.length || authority.markedCount < 0
      || authority.markedCount > authority.requestedCount) throw new Error('invalid bulk read authority result');
  const now = await validClock(ports);
  await ports.audit.append({ principalId: value.principalId, mode: 'bulk',
    requestedCount: authority.requestedCount, changedCount: authority.markedCount,
    outcome: 'completed', createdAt: now });
  const result = { kind: 'succeeded' as const, requestedCount: authority.requestedCount,
    markedCount: authority.markedCount };
  await ports.receipts.complete(binding, fingerprint, productResult(result));
  return result;
}

function validateOne(input: MarkNotificationReadInput): MarkNotificationReadInput {
  validateCommon(input); identity(input.notificationId, 128);
  if (typeof input.expectedStateRevision !== 'bigint' || input.expectedStateRevision < 0n
      || input.expectedStateRevision > POSTGRES_BIGINT_MAX) invalid();
  return Object.freeze({ principalId: input.principalId, notificationId: input.notificationId,
    expectedStateRevision: input.expectedStateRevision, commandId: input.commandId });
}
function validateBulk(input: MarkNotificationsReadInput): MarkNotificationsReadInput {
  validateCommon(input);
  if (!Array.isArray(input.notificationIds) || input.notificationIds.length < 1
      || input.notificationIds.length > NOTIFICATION_READ_BULK_MAX_ITEMS) invalid();
  for (const id of input.notificationIds) identity(id, 128);
  if (new Set(input.notificationIds).size !== input.notificationIds.length) invalid();
  return Object.freeze({ principalId: input.principalId,
    notificationIds: Object.freeze([...input.notificationIds]), commandId: input.commandId });
}
function validateCommon(input: { readonly principalId: string; readonly commandId: string }): void {
  if (!input || typeof input !== 'object') invalid(); identity(input.principalId, SOCIAL_IDENTITY_MAX_LENGTH);
  try { assertCanonicalCommandId(input.commandId); } catch { invalid(); }
}
function identity(value: unknown, max: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
      || value.trim() !== value || value.includes('\u0000')) invalid();
}
function invalid(): never {
  throw new NotificationReadCommandError('invalid_request', 'Notification read command is invalid.');
}
async function validClock(ports: NotificationReadCommandPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid(); return now;
}
function productResult(value: object, targetIdentity?: string): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(value, (_key, item) => typeof item === 'bigint'
    ? item.toString() : item), 'utf8');
  return { status: 200, body, stableHeaders: { 'cache-control': 'private, no-store',
    'content-type': 'application/json' }, mediaType: 'application/json',
    contractVersion: NOTIFICATION_READ_COMMAND_CONTRACT_VERSION,
    ...(targetIdentity ? { targetIdentity } : {}) };
}
function mapClaim(claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>): ClaimResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
