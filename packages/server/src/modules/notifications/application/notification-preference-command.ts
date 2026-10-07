import { createHash } from 'node:crypto';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';

export const NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION = '1.0.0';
export const NOTIFICATION_PREFERENCE_COMMAND_SCOPE = 'notification:preference:v1';
export const IN_APP_NOTIFICATION_DEFAULT_ENABLED = true;
/** P5-30: email channel defaults off in the authority (notification_preferences default). */
export const EMAIL_NOTIFICATION_DEFAULT_ENABLED = false;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type ProductNotificationChannel = 'in_app' | 'email';
export type NotificationPreferenceUpdateMode = 'set' | 'reset';
export type NotificationPreferenceCommandErrorCode = 'invalid_request' | 'stale_revision';

export class NotificationPreferenceCommandError extends Error {
  constructor(readonly code: NotificationPreferenceCommandErrorCode, message: string) {
    super(message); this.name = 'NotificationPreferenceCommandError';
  }
}

export interface GetNotificationPreferencesInput { readonly principalId: string; readonly signal?: AbortSignal }

/** Per-channel authority value exposed by the read port (P5-30 both channels). */
export interface NotificationPreferenceChannelValue {
  readonly enabled: boolean;
  readonly stateRevision: bigint;
  readonly updatedAt: Date;
}
export interface NotificationPreferenceReadPort {
  getForPrincipal(principalId: string, options?: { readonly signal?: AbortSignal }): Promise<{
    readonly inApp: NotificationPreferenceChannelValue;
    readonly email: NotificationPreferenceChannelValue;
    readonly emailSuppressed: boolean;
  }>;
}

/**
 * Additive email channel status on the Product preference read. `verifiedSender`
 * is the configured DirectMail AccountName (sender identity, not a secret) and is
 * null when the email feature is not configured. `emailAvailable` is honest:
 * false whenever the provider is not configured so the UI never fakes usability.
 */
export interface NotificationEmailStatus {
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly updatedAt: string;
  readonly verifiedSender: string | null;
  readonly emailSuppressed: boolean;
  readonly emailAvailable: boolean;
}
export interface ProductNotificationPreferences {
  readonly channel: 'in_app';
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly updatedAt: string;
  readonly email: NotificationEmailStatus;
}

/** Single-channel preference result returned by the update command / PUT route. */
export interface ProductNotificationPreference {
  readonly channel: ProductNotificationChannel;
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly updatedAt: string;
}

export type UpdateNotificationPreferenceInput =
  | { readonly principalId: string; readonly channel: ProductNotificationChannel;
      readonly mode: 'set'; readonly enabled: boolean; readonly expectedRevision: bigint;
      readonly commandId: string }
  | { readonly principalId: string; readonly channel: ProductNotificationChannel;
      readonly mode: 'reset'; readonly expectedRevision: bigint; readonly commandId: string };
export type NotificationPreferenceAuthorityResult =
  | { readonly kind: 'stale' }
  | { readonly enabled: boolean; readonly stateRevision: bigint; readonly updatedAt: Date;
      readonly changed: boolean };
export interface NotificationPreferenceAuditEvent {
  readonly principalId: string;
  readonly mode: NotificationPreferenceUpdateMode;
  readonly channel: ProductNotificationChannel;
  readonly changed: boolean;
  readonly outcome: 'updated' | 'unchanged';
  readonly createdAt: Date;
}
export interface NotificationPreferenceCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly authority: {
    update(input: {
      readonly principalId: string; readonly channel: ProductNotificationChannel;
      readonly enabled: boolean; readonly expectedRevision: bigint;
    }): Promise<NotificationPreferenceAuthorityResult>;
  };
  readonly audit: { append(event: NotificationPreferenceAuditEvent): Promise<void> };
  readonly clock: { now(): Promise<Date> };
}
type ClaimResult =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };
export type UpdateNotificationPreferenceResult =
  | ({ readonly kind: 'succeeded'; readonly changed: boolean } & ProductNotificationPreference)
  | ClaimResult;

/** P5-30 additive read: both channels plus per-channel email status. */
export async function getNotificationPreferences(read: NotificationPreferenceReadPort,
  input: GetNotificationPreferencesInput,
  emailRuntime: { readonly verifiedSender: string | null; readonly emailAvailable: boolean } = {
    verifiedSender: null, emailAvailable: false },
): Promise<ProductNotificationPreferences> {
  validatePrincipal(input?.principalId);
  const value = await read.getForPrincipal(input.principalId, { signal: input.signal });
  assertAuthorityValue(value.inApp);
  assertAuthorityValue(value.email);
  return Object.freeze({
    channel: 'in_app', enabled: value.inApp.enabled, revision: value.inApp.stateRevision,
    updatedAt: value.inApp.updatedAt.toISOString(),
    email: Object.freeze({ enabled: value.email.enabled,
      revision: value.email.stateRevision, updatedAt: value.email.updatedAt.toISOString(),
      verifiedSender: emailRuntime.verifiedSender ?? null,
      emailSuppressed: value.emailSuppressed === true,
      emailAvailable: emailRuntime.emailAvailable === true }),
  });
}

export function notificationPreferenceCommandFingerprint(
  input: UpdateNotificationPreferenceInput): string {
  const value = validateUpdate(input);
  return createHash('sha256').update(canonicalJson({ principalId: value.principalId,
    channel: value.channel, mode: value.mode,
    enabled: value.mode === 'set' ? value.enabled : defaultEnabledFor(value.channel),
    expectedRevision: value.expectedRevision.toString(),
    contractVersion: NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION,
  }), 'utf8').digest('hex');
}

export async function updateNotificationPreference(ports: NotificationPreferenceCommandPorts,
  input: UpdateNotificationPreferenceInput): Promise<UpdateNotificationPreferenceResult> {
  const value = validateUpdate(input);
  const fingerprint = notificationPreferenceCommandFingerprint(value);
  const binding = { principalId: value.principalId,
    commandScope: NOTIFICATION_PREFERENCE_COMMAND_SCOPE, commandId: value.commandId };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);
  const desired = value.mode === 'set' ? value.enabled : defaultEnabledFor(value.channel);
  const authority = await ports.authority.update({ principalId: value.principalId,
    channel: value.channel, enabled: desired, expectedRevision: value.expectedRevision });
  if ('kind' in authority) {
    throw new NotificationPreferenceCommandError('stale_revision',
      'Notification preference revision changed.');
  }
  assertAuthorityValue(authority);
  const now = await validClock(ports);
  const outcome = authority.changed ? 'updated' : 'unchanged';
  await ports.audit.append({ principalId: value.principalId, mode: value.mode,
    channel: value.channel, changed: authority.changed, outcome, createdAt: now });
  const result: Extract<UpdateNotificationPreferenceResult, { kind: 'succeeded' }> = {
    kind: 'succeeded', channel: value.channel, enabled: authority.enabled,
    revision: authority.stateRevision, updatedAt: authority.updatedAt.toISOString(),
    changed: authority.changed,
  };
  await ports.receipts.complete(binding, fingerprint, productResult(result));
  return Object.freeze(result);
}

function defaultEnabledFor(channel: ProductNotificationChannel): boolean {
  return channel === 'email' ? EMAIL_NOTIFICATION_DEFAULT_ENABLED : IN_APP_NOTIFICATION_DEFAULT_ENABLED;
}

function validateUpdate(input: UpdateNotificationPreferenceInput): UpdateNotificationPreferenceInput {
  if (!input || typeof input !== 'object') invalid();
  validatePrincipal(input.principalId);
  if ((input.channel !== 'in_app' && input.channel !== 'email')
      || !['set', 'reset'].includes(input.mode)) invalid();
  if (typeof input.expectedRevision !== 'bigint' || input.expectedRevision < 0n
      || input.expectedRevision > POSTGRES_BIGINT_MAX) invalid();
  try { assertCanonicalCommandId(input.commandId); } catch { invalid(); }
  if (input.mode === 'set') {
    if (typeof input.enabled !== 'boolean') invalid();
    return Object.freeze({ principalId: input.principalId, channel: input.channel, mode: 'set',
      enabled: input.enabled, expectedRevision: input.expectedRevision, commandId: input.commandId });
  }
  if ('enabled' in input) invalid();
  return Object.freeze({ principalId: input.principalId, channel: input.channel, mode: 'reset',
    expectedRevision: input.expectedRevision, commandId: input.commandId });
}

function validatePrincipal(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > SOCIAL_IDENTITY_MAX_LENGTH
      || value.trim() !== value || value.includes('\u0000')) invalid();
}
function assertAuthorityValue(value: {
  readonly enabled: unknown; readonly stateRevision: unknown; readonly updatedAt: unknown;
}): void {
  if (typeof value.enabled !== 'boolean' || typeof value.stateRevision !== 'bigint'
      || value.stateRevision < 0n || value.stateRevision > POSTGRES_BIGINT_MAX
      || !(value.updatedAt instanceof Date) || !Number.isFinite(value.updatedAt.getTime())) {
    throw new Error('invalid Notification preference authority result');
  }
}
function invalid(): never {
  throw new NotificationPreferenceCommandError('invalid_request',
    'Notification preference request is invalid.');
}
async function validClock(ports: NotificationPreferenceCommandPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  return now;
}
function productResult(value: object): ProductCommandResult {
  const body = Buffer.from(JSON.stringify(value, (_key, item) => typeof item === 'bigint'
    ? item.toString() : item), 'utf8');
  return { status: 200, body, stableHeaders: { 'cache-control': 'private, no-store',
    'content-type': 'application/json' }, mediaType: 'application/json',
    contractVersion: NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION,
    targetIdentity: (value as { channel?: string }).channel ?? 'in_app' };
}
function mapClaim(claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>): ClaimResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
