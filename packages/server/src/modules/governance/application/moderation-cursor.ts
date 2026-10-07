import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, createKeyedCursorCodec } from '../../commands/index.js';
import {
  GOVERNANCE_CURSOR_MAX_LENGTH,
  GOVERNANCE_CURSOR_TTL_MS,
  GovernanceModerationError,
} from '../domain/moderation.js';

export const MODERATION_CURSOR_KEY_ID = 'g2';
export const MY_REPORTS_CURSOR_PURPOSE = 'mr' as const;
export const OFFICIAL_CASES_CURSOR_PURPOSE = 'mc' as const;
export const MY_ACTIONS_CURSOR_PURPOSE = 'ma' as const;
export const MY_APPEALS_CURSOR_PURPOSE = 'ya' as const;
export const OFFICIAL_APPEALS_CURSOR_PURPOSE = 'oa' as const;
export type ModerationCursorPurpose =
  | typeof MY_REPORTS_CURSOR_PURPOSE
  | typeof OFFICIAL_CASES_CURSOR_PURPOSE
  | typeof MY_ACTIONS_CURSOR_PURPOSE
  | typeof MY_APPEALS_CURSOR_PURPOSE
  | typeof OFFICIAL_APPEALS_CURSOR_PURPOSE;

export class ModerationCursorExpiredError extends Error {
  readonly code = 'snapshot_expired';

  constructor() {
    super('snapshot_expired');
    this.name = 'ModerationCursorExpiredError';
  }
}

export interface ModerationCursorPayload {
  readonly v: 1;
  readonly purpose: ModerationCursorPurpose;
  readonly viewer: string;
  readonly status: string | null;
  readonly assignee: string | null;
  readonly after: { readonly createdAt: string; readonly id: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface ModerationCursorWire {
  readonly v: 1;
  readonly p: ModerationCursorPurpose;
  readonly b: string;
  readonly a: { readonly t: string; readonly i: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keyVersion: string;
}

export function createModerationCursorSigner(hmacKey: string): {
  sign(payload: ModerationCursorPayload): string;
  verify(token: string, now: Date): ModerationCursorPayload;
  destroy(): void;
} {
  const codec = createKeyedCursorCodec<ModerationCursorWire>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: GOVERNANCE_CURSOR_TTL_MS,
    keys: { current: { id: MODERATION_CURSOR_KEY_ID, key: hmacKey } },
    invalid: () => new GovernanceModerationError('invalid_cursor', 'cursor is invalid'),
    validate: validateWire,
    messages: {
      invalidKey: 'invalid moderation cursor key',
      tooManyKeys: 'moderation cursor supports at most 8 retained keys',
      uniqueKeys: 'moderation cursor keys must be unique',
      retention: 'moderation cursor retained key lifetime must cover cursor TTL',
    },
    maxPreviousKeys: 8,
    maxTokenLength: GOVERNANCE_CURSOR_MAX_LENGTH,
  });
  return Object.freeze({
    sign: (payload) => wrapSignedCursor(codec.sign(toWire(payload))),
    verify: (token, now) => {
      const dotted = unwrapSignedCursor(token);
      if (dotted === null) {
        throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
      }
      try {
        return fromWire(codec.verify(dotted, now), hmacKey);
      } catch (error: unknown) {
        if (isExpiredSignedCursor(dotted, hmacKey, now)) throw new ModerationCursorExpiredError();
        throw error;
      }
    },
    destroy: () => codec.destroy(),
  });
}

export function moderationCursorBind(input: {
  readonly purpose: ModerationCursorPayload['purpose'];
  readonly viewer: string;
  readonly status: string | null;
  readonly assignee: string | null;
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      a: input.assignee,
      p: input.purpose,
      s: input.status,
      v: input.viewer,
    }))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

function toWire(payload: ModerationCursorPayload): Omit<ModerationCursorWire, 'keyVersion'> {
  return {
    v: 1,
    p: payload.purpose,
    b: moderationCursorBind(payload),
    a: { t: payload.after.createdAt, i: payload.after.id },
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

function fromWire(wire: ModerationCursorWire, hmacKey: string): ModerationCursorPayload {
  void hmacKey;
  return {
    v: 1,
    purpose: wire.p,
    viewer: '',
    status: null,
    assignee: null,
    after: { createdAt: wire.a.t, id: wire.a.i },
    issuedAt: wire.issuedAt,
    expiresAt: wire.expiresAt,
  };
}

export function bindModerationCursor(
  wire: ReturnType<typeof createModerationCursorSigner>['verify'] extends (
    token: string,
    now: Date,
  ) => infer R ? R : never,
  expected: {
    readonly purpose: ModerationCursorPayload['purpose'];
    readonly viewer: string;
    readonly status: string | null;
    readonly assignee: string | null;
  },
  hmacKey: string,
  token: string,
): ModerationCursorPayload {
  const decoded = decodeBind(token);
  if (decoded === null || decoded.p !== expected.purpose) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  if (decoded.b !== moderationCursorBind(expected)) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  return {
    v: 1,
    purpose: expected.purpose,
    viewer: expected.viewer,
    status: expected.status,
    assignee: expected.assignee,
    after: wire.after,
    issuedAt: wire.issuedAt,
    expiresAt: wire.expiresAt,
  };
}

function wrapSignedCursor(dotted: string): string {
  return Buffer.from(dotted, 'utf8').toString('base64url');
}

function unwrapSignedCursor(token: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
  const dotted = Buffer.from(token, 'base64url').toString('utf8');
  if (Buffer.from(dotted, 'utf8').toString('base64url') !== token) return null;
  return dotted;
}

function decodeBind(token: string): { p: string; b: string } | null {
  const dotted = unwrapSignedCursor(token) ?? token;
  const parts = dotted.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      p?: unknown;
      b?: unknown;
    };
    if (typeof payload.p !== 'string' || typeof payload.b !== 'string') return null;
    return { p: payload.p, b: payload.b };
  } catch {
    return null;
  }
}

function isExpiredSignedCursor(token: string, hmacKey: string, now: Date): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [keyId, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', Buffer.from(hmacKey, 'utf8'))
    .update(`${keyId}.${body}`)
    .digest('base64url');
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

function validateWire(value: unknown): ModerationCursorWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || (record.p !== MY_REPORTS_CURSOR_PURPOSE
    && record.p !== OFFICIAL_CASES_CURSOR_PURPOSE
    && record.p !== MY_ACTIONS_CURSOR_PURPOSE
    && record.p !== MY_APPEALS_CURSOR_PURPOSE
    && record.p !== OFFICIAL_APPEALS_CURSOR_PURPOSE)) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  if (typeof record.b !== 'string' || record.b.length !== 22) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  if (typeof record.a !== 'object' || record.a === null || Array.isArray(record.a)) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  const after = record.a as Record<string, unknown>;
  if (typeof after.t !== 'string' || typeof after.i !== 'string' || after.i.length < 1 || after.i.length > 128) {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  if (typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  if (typeof record.keyVersion !== 'string') {
    throw new GovernanceModerationError('invalid_cursor', 'cursor is invalid');
  }
  return record as unknown as ModerationCursorWire;
}
