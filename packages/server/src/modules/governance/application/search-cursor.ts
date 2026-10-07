import { createHash } from 'node:crypto';
import { canonicalJson, createKeyedCursorCodec } from '../../commands/index.js';

export const SEARCH_GOVERNANCE_CURSOR_PURPOSE = 's';
export const SEARCH_GOVERNANCE_CURSOR_KEY_ID = 'g3';
export const SEARCH_GOVERNANCE_CURSOR_MAX_LENGTH = 4_096;
export const SEARCH_GOVERNANCE_CURSOR_TTL_MS = 900_000;

export interface SearchGovernanceCursorPayload {
  readonly v: 1;
  readonly purpose: typeof SEARCH_GOVERNANCE_CURSOR_PURPOSE;
  readonly viewer: string;
  readonly prefRev: string | null;
  readonly inner: string | null;
  readonly skip: number;
  readonly pageSize: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SearchGovernanceCursorView {
  readonly inner: string | null;
  readonly skip: number;
  readonly pageSize: number;
  readonly bind: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface SearchGovernanceCursorWire {
  readonly v: 1;
  readonly i: string | null;
  readonly k: number;
  readonly n: number;
  readonly b: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keyVersion: string;
}

export function searchGovernanceBindDigest(input: {
  readonly viewer: string;
  readonly prefRev: string | null;
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      p: input.prefRev,
      s: SEARCH_GOVERNANCE_CURSOR_PURPOSE,
      v: input.viewer,
    }))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function createSearchGovernanceCursorSigner(hmacKey: string): {
  sign(payload: SearchGovernanceCursorPayload): string;
  verify(token: string, now: Date): SearchGovernanceCursorView;
  destroy(): void;
} {
  const codec = createKeyedCursorCodec<SearchGovernanceCursorWire>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: SEARCH_GOVERNANCE_CURSOR_TTL_MS,
    keys: { current: { id: SEARCH_GOVERNANCE_CURSOR_KEY_ID, key: hmacKey } },
    invalid: () => new Error('invalid_cursor'),
    validate: validateSearchGovernanceCursorWire,
    messages: {
      invalidKey: 'invalid search governance cursor key',
      tooManyKeys: 'search governance cursor supports at most 8 retained keys',
      uniqueKeys: 'search governance cursor keys must be unique',
      retention: 'search governance cursor retained key lifetime must cover cursor TTL',
    },
    maxPreviousKeys: 8,
    maxTokenLength: SEARCH_GOVERNANCE_CURSOR_MAX_LENGTH,
  });
  return Object.freeze({
    sign: (payload) => codec.sign(toUnsignedWire(payload)),
    verify: (token, now) => fromWire(codec.verify(token, now)),
    destroy: () => codec.destroy(),
  });
}

function toUnsignedWire(
  payload: SearchGovernanceCursorPayload,
): Omit<SearchGovernanceCursorWire, 'keyVersion'> {
  return {
    v: 1,
    i: payload.inner,
    k: payload.skip,
    n: payload.pageSize,
    b: searchGovernanceBindDigest(payload),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

function fromWire(wire: SearchGovernanceCursorWire): SearchGovernanceCursorView {
  return {
    inner: wire.i,
    skip: wire.k,
    pageSize: wire.n,
    bind: wire.b,
    issuedAt: wire.issuedAt,
    expiresAt: wire.expiresAt,
  };
}

function validateSearchGovernanceCursorWire(value: unknown): SearchGovernanceCursorWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_cursor');
  const record = value as Record<string, unknown>;
  if (record.v !== 1) throw new Error('invalid_cursor');
  if (record.i !== null && (typeof record.i !== 'string' || record.i.length < 1 || record.i.length > 2_048)) {
    throw new Error('invalid_cursor');
  }
  if (typeof record.k !== 'number' || !Number.isInteger(record.k) || record.k < 0 || record.k > 100) {
    throw new Error('invalid_cursor');
  }
  if (typeof record.n !== 'number' || !Number.isInteger(record.n) || record.n < 1 || record.n > 100) {
    throw new Error('invalid_cursor');
  }
  if (typeof record.b !== 'string' || record.b.length !== 22) throw new Error('invalid_cursor');
  if (typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') {
    throw new Error('invalid_cursor');
  }
  if (typeof record.keyVersion !== 'string') throw new Error('invalid_cursor');
  return record as unknown as SearchGovernanceCursorWire;
}
