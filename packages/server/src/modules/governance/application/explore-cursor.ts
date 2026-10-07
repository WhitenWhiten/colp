import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, createKeyedCursorCodec } from '../../commands/index.js';
import type { ExplorePagePosition, ExplorePageSort } from '../../publication/index.js';

export const EXPLORE_GOVERNANCE_CURSOR_PURPOSE = 'e';
export const EXPLORE_GOVERNANCE_CURSOR_KEY_ID = 'g1';
export const EXPLORE_GOVERNANCE_CURSOR_MAX_LENGTH = 512;

export class ExploreGovernanceCursorExpiredError extends Error {
  readonly code = 'snapshot_expired';

  constructor() {
    super('snapshot_expired');
    this.name = 'ExploreGovernanceCursorExpiredError';
  }
}

export interface ExploreGovernanceCursorPayload {
  readonly v: 1;
  readonly purpose: typeof EXPLORE_GOVERNANCE_CURSOR_PURPOSE;
  readonly sort: ExplorePageSort;
  readonly language: string | null;
  readonly viewer: string | null;
  readonly prefRev: string | null;
  readonly after: ExplorePagePosition;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ExploreGovernanceCursorView {
  readonly sort: ExplorePageSort;
  readonly after: ExplorePagePosition;
  readonly bind: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const SORT_WIRE = { updated: 'u', popular: 'p', links: 'l' } as const;
const SORT_FROM_WIRE = { u: 'updated', p: 'popular', l: 'links' } as const;

interface ExploreGovernanceCursorWire {
  readonly v: 1;
  readonly s: keyof typeof SORT_FROM_WIRE;
  readonly b: string;
  readonly a: { readonly i: string; readonly m: string; readonly n?: number };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keyVersion: string;
}

export function exploreGovernanceBindDigest(input: {
  readonly language: string | null;
  readonly viewer: string | null;
  readonly prefRev: string | null;
  readonly sort: ExplorePageSort;
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      e: EXPLORE_GOVERNANCE_CURSOR_PURPOSE,
      l: input.language,
      p: input.prefRev,
      s: input.sort,
      v: input.viewer,
    }))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function createExploreGovernanceCursorSigner(hmacKey: string): {
  sign(payload: ExploreGovernanceCursorPayload): string;
  verify(token: string, now: Date): ExploreGovernanceCursorView;
  destroy(): void;
} {
  const codec = createKeyedCursorCodec<ExploreGovernanceCursorWire>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: 900_000,
    keys: { current: { id: EXPLORE_GOVERNANCE_CURSOR_KEY_ID, key: hmacKey } },
    invalid: () => new Error('invalid_cursor'),
    validate: validateExploreGovernanceCursorWire,
    messages: {
      invalidKey: 'invalid explore governance cursor key',
      tooManyKeys: 'explore governance cursor supports at most 8 retained keys',
      uniqueKeys: 'explore governance cursor keys must be unique',
      retention: 'explore governance cursor retained key lifetime must cover cursor TTL',
    },
    maxPreviousKeys: 8,
    maxTokenLength: EXPLORE_GOVERNANCE_CURSOR_MAX_LENGTH,
  });
  return Object.freeze({
    sign: (payload) => codec.sign(toUnsignedWire(payload)),
    verify: (token, now) => {
      try {
        return fromWire(codec.verify(token, now));
      } catch (error: unknown) {
        if (isExpiredSignedExploreCursor(token, hmacKey, now)) {
          throw new ExploreGovernanceCursorExpiredError();
        }
        throw error;
      }
    },
    destroy: () => codec.destroy(),
  });
}

function toUnsignedWire(payload: ExploreGovernanceCursorPayload): Omit<ExploreGovernanceCursorWire, 'keyVersion'> {
  const extra = payload.sort === 'popular'
    ? payload.after.viewCount
    : payload.sort === 'links'
      ? payload.after.nodeCount
      : undefined;
  return {
    v: 1,
    s: SORT_WIRE[payload.sort],
    b: exploreGovernanceBindDigest(payload),
    a: {
      i: payload.after.id,
      m: payload.after.micros,
      ...(extra !== undefined ? { n: extra } : {}),
    },
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

function fromWire(wire: ExploreGovernanceCursorWire): ExploreGovernanceCursorView {
  const sort = SORT_FROM_WIRE[wire.s];
  return {
    sort,
    bind: wire.b,
    issuedAt: wire.issuedAt,
    expiresAt: wire.expiresAt,
    after: {
      micros: wire.a.m,
      id: wire.a.i,
      ...(sort === 'popular' ? { viewCount: wire.a.n } : {}),
      ...(sort === 'links' ? { nodeCount: wire.a.n } : {}),
    },
  };
}

function isExpiredSignedExploreCursor(token: string, hmacKey: string, now: Date): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [keyId, body, signature] = parts as [string, string, string];
  const key = Buffer.from(hmacKey, 'utf8');
  const expected = createHmac('sha256', key).update(`${keyId}.${body}`).digest('base64url');
  const actual = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { expiresAt?: unknown };
    if (typeof payload.expiresAt !== 'string') return false;
    const expiresAt = Date.parse(payload.expiresAt);
    return Number.isFinite(expiresAt) && now.getTime() >= expiresAt;
  } catch {
    return false;
  }
}

function validateExploreGovernanceCursorWire(value: unknown): ExploreGovernanceCursorWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_cursor');
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || (record.s !== 'u' && record.s !== 'p' && record.s !== 'l')) {
    throw new Error('invalid_cursor');
  }
  if (typeof record.b !== 'string' || record.b.length !== 22) throw new Error('invalid_cursor');
  if (typeof record.a !== 'object' || record.a === null || Array.isArray(record.a)) {
    throw new Error('invalid_cursor');
  }
  const after = record.a as Record<string, unknown>;
  if (typeof after.i !== 'string' || after.i.length < 1 || after.i.length > 128) {
    throw new Error('invalid_cursor');
  }
  if (typeof after.m !== 'string' || !/^-?\d{1,20}$/u.test(after.m)) throw new Error('invalid_cursor');
  if (record.s === 'u') {
    if (after.n !== undefined) throw new Error('invalid_cursor');
  } else if (typeof after.n !== 'number' || !Number.isSafeInteger(after.n) || after.n < 0) {
    throw new Error('invalid_cursor');
  }
  if (typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') {
    throw new Error('invalid_cursor');
  }
  if (typeof record.keyVersion !== 'string') throw new Error('invalid_cursor');
  return record as unknown as ExploreGovernanceCursorWire;
}
