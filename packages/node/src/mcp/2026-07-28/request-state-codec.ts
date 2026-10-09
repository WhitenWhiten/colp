import { createHmac, timingSafeEqual } from 'node:crypto';
import type { McpAuthenticatedAuthorizationBinding } from '../shared/authorization.js';
import { requestStateBindingMaterial } from './request-state-binding.js';

/** Stable machine-readable codes for server-minted requestState failures. */
export type Mcp20260728WriteRequestStateErrorCode =
  | 'invalid_request_state'
  | 'request_state_expired'
  | 'request_state_binding_mismatch'
  | 'request_state_mismatch';

/** Typed failure for server-minted `requestState` verification. */
export class Mcp20260728WriteRequestStateError extends Error {
  readonly code: Mcp20260728WriteRequestStateErrorCode;

  constructor(code: Mcp20260728WriteRequestStateErrorCode, message: string) {
    super(message);
    this.name = 'Mcp20260728WriteRequestStateError';
    this.code = code;
  }
}

const REQUEST_STATE_PREFIX = 'colp.rs.' as const;
const REQUEST_STATE_MAX_BYTES = 16 * 1024;
const REQUEST_STATE_MAX_BODY_BYTES = 12 * 1024;
const REQUEST_STATE_MAX_PLAN_ID_LENGTH = 128;
const REQUEST_STATE_MAX_METHOD_LENGTH = 128;
const REQUEST_STATE_MAX_DIGEST_LENGTH = 256;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

export interface RequestStatePayload {
  readonly planId: string;
  readonly method: string;
  readonly inputDigest: string;
}

interface RequestStateCodec {
  readonly mint: (
    payload: RequestStatePayload,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => string;
  readonly verify: (
    state: string,
    expected: Readonly<{
      method: string;
      inputDigest: string;
      binding: McpAuthenticatedAuthorizationBinding;
    }>,
  ) => RequestStatePayload;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new Error('Malformed base64url.');
  }
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function base64UrlEqual(left: string, right: string): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = base64UrlDecode(left);
    rightBytes = base64UrlDecode(right);
  } catch {
    return false;
  }
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createRequestStateCodec(options: Readonly<{
  key: Uint8Array;
  ttlSeconds: number;
  now: () => number;
}>): RequestStateCodec {
  const hmac = (data: string | Uint8Array): Uint8Array => {
    const digest = createHmac('sha256', options.key);
    if (typeof data === 'string') digest.update(data, 'utf8');
    else digest.update(data);
    return new Uint8Array(digest.digest());
  };
  const bindTag = (binding: McpAuthenticatedAuthorizationBinding): string =>
    base64UrlEncode(hmac(requestStateBindingMaterial(binding)).subarray(0, 16));

  const codec: RequestStateCodec = {
    mint: (payload, binding) => {
      if (
        payload.planId.length === 0 || payload.planId.length > REQUEST_STATE_MAX_PLAN_ID_LENGTH
        || payload.method.length === 0 || payload.method.length > REQUEST_STATE_MAX_METHOD_LENGTH
        || payload.inputDigest.length === 0 || payload.inputDigest.length > REQUEST_STATE_MAX_DIGEST_LENGTH
      ) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState payload exceeds its budget.');
      }
      const envelope = {
        p: payload,
        exp: Math.floor(options.now() / 1000) + options.ttlSeconds,
        b: bindTag(binding),
      };
      const body = base64UrlEncode(Buffer.from(JSON.stringify(envelope), 'utf8'));
      if (body.length > REQUEST_STATE_MAX_BODY_BYTES) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState payload exceeds its budget.');
      }
      const mac = base64UrlEncode(hmac(REQUEST_STATE_PREFIX + body));
      const state = `${REQUEST_STATE_PREFIX}${body}.${mac}`;
      if (Buffer.byteLength(state, 'utf8') > REQUEST_STATE_MAX_BYTES) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState exceeds its byte budget.');
      }
      return state;
    },
    verify: (state, expected) => {
      if (typeof state !== 'string' || !state.startsWith(REQUEST_STATE_PREFIX)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState.');
      }
      if (Buffer.byteLength(state, 'utf8') > REQUEST_STATE_MAX_BYTES) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState exceeds its byte budget.');
      }
      const dot = state.lastIndexOf('.');
      if (dot < REQUEST_STATE_PREFIX.length + 1) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState.');
      }
      const body = state.slice(REQUEST_STATE_PREFIX.length, dot);
      const mac = state.slice(dot + 1);
      const expectedMac = base64UrlEncode(hmac(REQUEST_STATE_PREFIX + body));
      if (!base64UrlEqual(mac, expectedMac)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState MAC verification failed.');
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(body)),
        );
      } catch {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState envelope.');
      }
      if (typeof envelope !== 'object' || envelope === null) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState envelope.');
      }
      const record = envelope as Readonly<Record<string, unknown>>;
      const payload = record.p;
      const exp = record.exp;
      const tag = record.b;
      if (typeof payload !== 'object' || payload === null) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState payload.');
      }
      if (typeof exp !== 'number' || !Number.isFinite(exp)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState expiry.');
      }
      if (exp < Math.floor(options.now() / 1000)) {
        throw new Mcp20260728WriteRequestStateError('request_state_expired', 'requestState has expired.');
      }
      if (tag !== bindTag(expected.binding)) {
        throw new Mcp20260728WriteRequestStateError(
          'request_state_binding_mismatch',
          'requestState is bound to a different authenticated principal.',
        );
      }
      const typed = payload as Readonly<Record<string, unknown>>;
      const planId = typed.planId;
      const method = typed.method;
      const inputDigest = typed.inputDigest;
      if (
        typeof planId !== 'string'
        || planId.length === 0 || planId.length > REQUEST_STATE_MAX_PLAN_ID_LENGTH
        || typeof method !== 'string' || method.length === 0 || method.length > REQUEST_STATE_MAX_METHOD_LENGTH
        || typeof inputDigest !== 'string' || inputDigest.length === 0
        || inputDigest.length > REQUEST_STATE_MAX_DIGEST_LENGTH
      ) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState payload.');
      }
      if (method !== expected.method || inputDigest !== expected.inputDigest) {
        throw new Mcp20260728WriteRequestStateError(
          'request_state_mismatch',
          'requestState does not match this request.',
        );
      }
      return Object.freeze({ planId, method, inputDigest });
    },
  };
  return Object.freeze(codec);
}
