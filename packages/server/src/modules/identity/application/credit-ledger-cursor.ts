import { MAX_CREDIT_POINTS } from './credits.js';
import {
  createKeyedCursorCodec,
  type KeyedCursorCodec,
} from '../../commands/index.js';

export const CREDIT_LEDGER_CURSOR_PURPOSE = 'credits-ledger.v1' as const;
export const CREDIT_LEDGER_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreditLedgerCursorBalance {
  readonly available: number;
  readonly reserved: number;
  readonly nextExpiryAt: string | null;
  readonly expiringPoints: number;
}

export interface CreditLedgerCursorPayload {
  readonly version: 1;
  readonly accountId: string;
  readonly filters: Readonly<Record<string, string | null>>;
  readonly limit: number;
  readonly asOf: string;
  readonly highSequence: string;
  readonly balance: CreditLedgerCursorBalance;
  readonly beforeSequence: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CreditLedgerCursorKeyConfig {
  readonly id: string;
  readonly secret: string;
}

export function createCreditLedgerCursorCodec(input: {
  readonly active: CreditLedgerCursorKeyConfig;
  readonly retained: readonly CreditLedgerCursorKeyConfig[];
}): KeyedCursorCodec<CreditLedgerCursorPayload> {
  return createKeyedCursorCodec<CreditLedgerCursorPayload>({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'prefixed', prefix: 'creditsv1', encoding: 'ascii',
      hkdfSalt: 'known/credits/cursor/v1', purpose: CREDIT_LEDGER_CURSOR_PURPOSE,
    },
    keys: { current: input.active, previous: input.retained },
    maxTokenLength: 4096,
    invalid: () => new Error('invalid_cursor'),
    validate(value): CreditLedgerCursorPayload {
      if (!isRecord(value) || Object.keys(value).sort().join(',') !==
        'accountId,asOf,balance,beforeSequence,expiresAt,filters,highSequence,issuedAt,limit,version') {
        throw new Error('invalid_cursor');
      }
      const filterRecord = isRecord(value.filters) ? value.filters : undefined;
      const filterShape = filterRecord !== undefined
        && Object.keys(filterRecord).sort().join(',') === 'chargeId,from,kind,runId,to'
        && Object.values(filterRecord).every((item) => item === null || typeof item === 'string');
      const limit = value.limit;
      if (value.version !== 1 || typeof value.accountId !== 'string' || !isRecord(value.filters)
        || !filterShape
        || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || value.accountId.length === 0 || value.accountId.length > 128
        || !isTimestamp(value.asOf) || !isSequence(value.highSequence)
        || !isSequence(value.beforeSequence) || !isTimestamp(value.issuedAt)
        || !isTimestamp(value.expiresAt) || !isBalance(value.balance)
        || BigInt(value.beforeSequence) === 0n || BigInt(value.beforeSequence) > BigInt(value.highSequence)) {
        throw new Error('invalid_cursor');
      }
      return value as unknown as CreditLedgerCursorPayload;
    },
    messages: {
      invalidKey: 'Credit ledger cursor key is invalid',
      canonicalSecret: 'Credit ledger cursor key secret must be canonical base64',
      uniqueKeys: 'Credit ledger cursor keys must be unique',
    },
  });
}

function isBalance(value: unknown): value is CreditLedgerCursorBalance {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'available,expiringPoints,nextExpiryAt,reserved') return false;
  const available = value.available;
  const reserved = value.reserved;
  const expiringPoints = value.expiringPoints;
  return typeof available === 'number' && Number.isSafeInteger(available) && available >= 0 && available <= MAX_CREDIT_POINTS
    && typeof reserved === 'number' && Number.isSafeInteger(reserved) && reserved >= 0 && reserved <= MAX_CREDIT_POINTS
    && (value.nextExpiryAt === null || isTimestamp(value.nextExpiryAt))
    && typeof expiringPoints === 'number' && Number.isSafeInteger(expiringPoints) && expiringPoints >= 0
    && expiringPoints <= available && available + reserved <= MAX_CREDIT_POINTS
    && (value.nextExpiryAt === null ? expiringPoints === 0 : expiringPoints > 0);
}

function isSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
