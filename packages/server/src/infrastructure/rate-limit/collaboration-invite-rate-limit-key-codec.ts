/**
 * Collaboration invite rate-limit HMAC key codec (SC-02).
 *
 * Independent of auth/search/insights purpose strings. Hash-tag purpose is
 * `collaboration-invite`; family is `collaboration-invite`.
 *
 * Canonical key:
 *   known:<env>:ratelimit:v1:{collaboration-invite:<subjectHmac>}:collaboration-invite:<action>:<window>
 */
import { createHmac } from 'node:crypto';

export const COLLABORATION_INVITE_RATE_LIMIT_FAMILY = 'collaboration-invite' as const;
export type CollaborationInviteRateLimitFamily = typeof COLLABORATION_INVITE_RATE_LIMIT_FAMILY;

export const COLLABORATION_INVITE_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
export const COLLABORATION_INVITE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const COLLABORATION_INVITE_RATE_LIMIT_KEY_MAX_LENGTH = 512;
export const COLLABORATION_INVITE_POST_LIMIT = 20;
export const COLLABORATION_INVITE_POST_WINDOW_MS = 60 * 60 * 1000;
export const COLLABORATION_ACCEPT_DECLINE_LIMIT = 60;
export const COLLABORATION_ACCEPT_DECLINE_WINDOW_MS = 60 * 60 * 1000;

export type CollaborationInviteRateLimitAction = 'invite' | 'accept-or-decline';

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{collaboration-invite:([A-Za-z0-9_-]{32})\}:collaboration-invite:(invite|accept-or-decline):(\d{1,16})$/u;

export interface CollaborationInviteRateLimitKeyBuildInput {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly principalId: string;
  readonly action: CollaborationInviteRateLimitAction;
  readonly windowStartEpochMs: number;
}

export class CollaborationInviteRateLimitKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationInviteRateLimitKeyError';
  }
}

export function collaborationInviteRateLimitSubjectHmac(keySecret: Buffer, principalId: string): string {
  if (typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 512) {
    throw new CollaborationInviteRateLimitKeyError(
      'collaboration-invite rate-limit principal must be 1-512 characters',
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(principalId)) {
    throw new CollaborationInviteRateLimitKeyError(
      'collaboration-invite rate-limit principal must not contain control characters',
    );
  }
  return createHmac('sha256', keySecret)
    .update(principalId, 'utf8')
    .digest('base64url')
    .slice(0, COLLABORATION_INVITE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export type CollaborationInviteRateLimitKeyParseResult =
  | {
      readonly kind: 'ok';
      readonly parts: {
        readonly keyPrefix: string;
        readonly environment: string;
        readonly schemaVersion: typeof COLLABORATION_INVITE_RATE_LIMIT_KEY_SCHEMA_VERSION;
        readonly subjectHmac: string;
        readonly action: CollaborationInviteRateLimitAction;
        readonly windowStartEpochMs: number;
      };
    }
  | { readonly kind: 'rejected'; readonly reason: 'malformed' | 'invalid_window' };

export function parseCollaborationInviteRateLimitKey(key: string): CollaborationInviteRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > COLLABORATION_INVITE_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = KEY_PATTERN.exec(key);
  if (!match) return { kind: 'rejected', reason: 'malformed' };
  const windowRaw = match[5]!;
  if (windowRaw.length > 1 && windowRaw.startsWith('0')) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  const windowStartEpochMs = Number(windowRaw);
  if (!Number.isSafeInteger(windowStartEpochMs)) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  return {
    kind: 'ok',
    parts: Object.freeze({
      keyPrefix: match[1]!,
      environment: match[2]!,
      schemaVersion: COLLABORATION_INVITE_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      action: match[4] as CollaborationInviteRateLimitAction,
      windowStartEpochMs,
    }),
  };
}

export function buildCollaborationInviteRateLimitKey(
  input: CollaborationInviteRateLimitKeyBuildInput,
): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new CollaborationInviteRateLimitKeyError('collaboration-invite rate-limit key prefix is invalid');
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new CollaborationInviteRateLimitKeyError('collaboration-invite rate-limit key environment is invalid');
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new CollaborationInviteRateLimitKeyError(
      'collaboration-invite rate-limit key window must be a non-negative safe integer',
    );
  }
  const subjectHmac = collaborationInviteRateLimitSubjectHmac(input.keySecret, input.principalId);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${COLLABORATION_INVITE_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{collaboration-invite:${subjectHmac}}:${COLLABORATION_INVITE_RATE_LIMIT_FAMILY}:${input.action}:${input.windowStartEpochMs}`;
  if (key.length > COLLABORATION_INVITE_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new CollaborationInviteRateLimitKeyError(
      `collaboration-invite rate-limit key exceeds ${COLLABORATION_INVITE_RATE_LIMIT_KEY_MAX_LENGTH} characters`,
    );
  }
  if (parseCollaborationInviteRateLimitKey(key).kind !== 'ok') {
    throw new CollaborationInviteRateLimitKeyError('built collaboration-invite rate-limit key failed canonical parse');
  }
  return key;
}
