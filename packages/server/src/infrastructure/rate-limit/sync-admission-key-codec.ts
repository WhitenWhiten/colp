import { createHmac } from 'node:crypto';
import {
  SYNC_ADMISSION_PURPOSES,
  type SyncAdmissionPurpose,
} from './sync-admission-policy.js';

export const SYNC_ADMISSION_KEY_SCHEMA_VERSION = 1;
export const SYNC_ADMISSION_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const SYNC_ADMISSION_KEY_MAX_LENGTH = 512;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const PURPOSE_PATTERN = SYNC_ADMISSION_PURPOSES.join('|');
const SYNC_ADMISSION_KEY_PATTERN = new RegExp(
  `^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):admit:v1:\\{sync:([A-Za-z0-9_-]{32})\\}:(${PURPOSE_PATTERN}):(\\d{1,16})$`,
  'u',
);

export function syncAdmissionSubjectHmac(keySecret: Buffer, subject: string): string {
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 256) {
    throw new Error('sync admission subject must be 1-256 characters');
  }
  if (CONTROL_CHARACTER_PATTERN.test(subject)) {
    throw new Error('sync admission subject must not contain control characters');
  }
  return createHmac('sha256', keySecret)
    .update(subject, 'utf8')
    .digest('base64url')
    .slice(0, SYNC_ADMISSION_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export function buildSyncAdmissionKey(input: {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly purpose: SyncAdmissionPurpose;
  readonly subject: string;
  readonly windowStartEpochMs: number;
}): string {
  const keyPrefix = input.keyPrefix ?? 'known-sync';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new Error('sync admission key prefix is invalid');
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new Error('sync admission environment is invalid');
  }
  if (!SYNC_ADMISSION_PURPOSES.includes(input.purpose)) {
    throw new Error('unknown sync admission purpose');
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new Error('sync admission window must be a non-negative safe integer');
  }
  const subjectHmac = syncAdmissionSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:admit:v${SYNC_ADMISSION_KEY_SCHEMA_VERSION}`
    + `:{sync:${subjectHmac}}:${input.purpose}:${input.windowStartEpochMs}`;
  if (key.length > SYNC_ADMISSION_KEY_MAX_LENGTH) {
    throw new Error('sync admission key exceeds max length');
  }
  if (!SYNC_ADMISSION_KEY_PATTERN.test(key)) {
    throw new Error('built sync admission key failed canonical parse');
  }
  return key;
}
