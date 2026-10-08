import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { canonicalJson } from './receipt.js';

export const KEYED_CURSOR_MODES = Object.freeze(['hmac-sha256', 'aes-256-gcm'] as const);
export type KeyedCursorMode = (typeof KEYED_CURSOR_MODES)[number];

export const CURSOR_TIMESTAMP_MODES = Object.freeze([
  'rfc3339-optional-fraction',
  'rfc3339-millis',
  'rfc3339-seconds',
] as const);
export type CursorTimestampMode = (typeof CURSOR_TIMESTAMP_MODES)[number];

export interface KeyedCursorKeyInput {
  readonly id: string;
  readonly secret: string;
}

export interface KeyedCursorPreviousKeyInput extends KeyedCursorKeyInput {
  readonly lastIssuedAt?: string;
  readonly retainUntil?: string;
}

export interface KeyedCursorKeyringInput {
  readonly current: KeyedCursorKeyInput;
  readonly previous?: readonly KeyedCursorPreviousKeyInput[];
}

export interface KeyedCursorPolicyMessages {
  readonly invalidKey: string;
  readonly tooManyKeys: string;
  readonly uniqueKeys: string;
  readonly retention: string;
  readonly canonicalSecret?: string;
}

export interface KeyedCursorCodec<TPayload> {
  readonly activeKeyId: string;
  sign(payload: unknown): string;
  seal(payload: unknown): string;
  verify(token: string, now: Date): TPayload;
  destroy(): void;
  encodedLength(payload: TPayload): number;
}

export type EditorCursorRejectMetric =
  | 'rejected_malformed_token'
  | 'rejected_unknown_key'
  | 'rejected_retired_key'
  | 'rejected_bad_signature'
  | 'rejected_invalid_payload'
  | 'rejected_expired'
  | 'rejected_legacy_disabled';

export type EditorCursorObserveMetric =
  | 'issued'
  | 'issued_legacy'
  | 'verified_current'
  | 'verified_previous'
  | 'verified_legacy'
  | EditorCursorRejectMetric;

const HMAC_SIGNATURE_B64URL_LENGTH = 43;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const BODY_CHARSET = /^[A-Za-z0-9_-]+$/u;
const HMAC_SIGNATURE_CHARSET = /^[A-Za-z0-9_-]{43}$/u;
const AES_IV_CHARSET = /^[A-Za-z0-9_-]{16}$/u;
const AES_TAG_CHARSET = /^[A-Za-z0-9_-]{22}$/u;
const OPTIONAL_FRACTION_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function isCursorKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value);
}

export function recordWithExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function parseCursorTimestamp(value: string, mode: CursorTimestampMode = 'rfc3339-optional-fraction'): number {
  if (typeof value !== 'string') throw new Error();
  if (mode === 'rfc3339-millis') {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error();
    return parsed;
  }
  if (mode === 'rfc3339-seconds') {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, 'Z') !== value) {
      throw new Error();
    }
    return parsed;
  }
  if (!OPTIONAL_FRACTION_UTC.test(value)) throw new Error();
  const parsed = Date.parse(value);
  const millis = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  if (!Number.isFinite(parsed) || (millis !== value && millis.replace(/\.000Z$/, 'Z') !== value)) {
    throw new Error();
  }
  return parsed;
}

export function hmacSha256Base64Url(
  key: Buffer | string,
  value: string,
  encoding: 'utf8' | 'ascii' = 'utf8',
): string {
  return createHmac('sha256', key).update(value, encoding).digest('base64url');
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function timingSafeEqualBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function deriveHmacPurposeKey(key: string, purpose: string): string {
  return createHmac('sha256', key).update(purpose).digest('base64url');
}

export function deriveHkdfSha256(
  secret: Buffer,
  salt: string,
  info: string,
  length = 32,
): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(salt), Buffer.from(info), length));
}

export function encodeCanonicalCursorBody(payload: unknown): {
  readonly body: string;
  readonly canonical: string;
} {
  const canonical = canonicalJson(payload);
  return { body: Buffer.from(canonical, 'utf8').toString('base64url'), canonical };
}

export function decodeCanonicalBase64Url(text: string): Buffer {
  const value = Buffer.from(text, 'base64url');
  if (value.toString('base64url') !== text) throw new Error();
  return value;
}

export function decodeCanonicalCursorBody(body: string): string {
  const decoded = decodeCanonicalBase64Url(body);
  const canonical = decoded.toString('utf8');
  if (canonical.length < 1) throw new Error();
  return canonical;
}

export interface HmacProductCursorConfig<TPayload> {
  readonly mode: 'hmac-sha256';
  readonly hmac: { readonly variant: 'product' };
  readonly ttlMs: number;
  readonly keys: {
    readonly current: { readonly id: string; readonly key: string };
    readonly previous?: readonly {
      readonly id: string;
      readonly key: string;
      readonly lastIssuedAt: string;
      readonly retainUntil: string;
    }[];
  };
  readonly invalid: () => Error;
  readonly validate: (value: unknown) => TPayload;
  readonly messages: KeyedCursorPolicyMessages;
  readonly maxPreviousKeys?: number;
  readonly maxTokenLength?: number;
}

export interface HmacDerivedCursorConfig<TPayload> {
  readonly mode: 'hmac-sha256';
  readonly hmac: { readonly variant: 'derived'; readonly purpose: string };
  readonly ttlMs: number;
  readonly keys: {
    readonly current: { readonly id: string; readonly key: string };
    readonly previous?: readonly {
      readonly id: string;
      readonly key: string;
      readonly retainUntil?: string;
    }[];
  };
  readonly invalid: () => Error;
  readonly validate: (value: unknown) => TPayload;
  readonly messages: {
    readonly invalidCurrent: string;
    readonly uniqueIds: string;
    readonly invalidRetainUntil: string;
  };
}

export interface HmacEditorCursorConfig<TPayload> {
  readonly mode: 'hmac-sha256';
  readonly hmac: {
    readonly variant: 'editor';
    readonly issuanceFormat?: 'legacy' | 'keyed';
    readonly legacyAcceptUntil?: string;
    readonly observe?: (metric: EditorCursorObserveMetric) => void;
    readonly maxPreviousKeys?: number;
  };
  readonly ttlMs: number;
  readonly keys: {
    readonly current: { readonly id: string; readonly key: string };
    readonly previous?: readonly {
      readonly id: string;
      readonly key: string;
      readonly lastIssuedAt: string;
      readonly retainUntil: string;
    }[];
  };
  readonly invalid: () => Error;
  readonly validate: (value: unknown) => TPayload;
}

export interface HmacPrefixedCursorConfig<TPayload> {
  readonly mode: 'hmac-sha256';
  readonly hmac: {
    readonly variant: 'prefixed';
    readonly prefix: string;
    readonly encoding?: 'utf8' | 'ascii';
    readonly hkdfSalt: string;
    readonly purpose: string;
  };
  readonly keys: {
    readonly current: KeyedCursorKeyInput;
    readonly previous?: readonly KeyedCursorKeyInput[];
  };
  readonly invalid: () => Error;
  readonly validate: (value: unknown) => TPayload;
  readonly messages: Pick<KeyedCursorPolicyMessages, 'invalidKey' | 'canonicalSecret' | 'uniqueKeys'>;
  readonly maxTokenLength?: number;
}

export interface AesGcmCursorConfig<TPayload> {
  readonly mode: 'aes-256-gcm';
  readonly purpose: string;
  readonly prefix: string;
  readonly hkdfSalt: string;
  readonly ttlMs: number;
  readonly keys: {
    readonly current: KeyedCursorKeyInput;
    readonly previous?: readonly (KeyedCursorKeyInput & {
      readonly lastIssuedAt: string;
      readonly retainUntil: string;
    })[];
  };
  readonly invalid: () => Error;
  readonly validate: (value: unknown) => TPayload;
  readonly messages: KeyedCursorPolicyMessages;
  readonly maxPreviousKeys?: number;
  readonly maxTokenLength?: number;
}

export type KeyedCursorCodecConfig<TPayload> =
  | HmacProductCursorConfig<TPayload>
  | HmacDerivedCursorConfig<TPayload>
  | HmacEditorCursorConfig<TPayload>
  | HmacPrefixedCursorConfig<TPayload>
  | AesGcmCursorConfig<TPayload>;

export function createKeyedCursorCodec<TPayload>(
  config: KeyedCursorCodecConfig<TPayload>,
): KeyedCursorCodec<TPayload> {
  if (config.mode === 'aes-256-gcm') return createAesGcmCodec(config);
  if (isHmacCursorVariant(config, 'product')) return createHmacProductCodec(config);
  if (isHmacCursorVariant(config, 'derived')) return createHmacDerivedCodec(config);
  if (isHmacCursorVariant(config, 'prefixed')) return createHmacPrefixedCodec(config);
  return createHmacEditorCodec(config);
}

type HmacCursorConfig<TPayload> = Exclude<KeyedCursorCodecConfig<TPayload>, AesGcmCursorConfig<TPayload>>;

function isHmacCursorVariant<TPayload, V extends HmacCursorConfig<TPayload>['hmac']['variant']>(
  config: HmacCursorConfig<TPayload>,
  variant: V,
): config is Extract<HmacCursorConfig<TPayload>, { readonly hmac: { readonly variant: V } }> {
  return config.hmac.variant === variant;
}

function createHmacProductCodec<TPayload>(
  config: HmacProductCursorConfig<TPayload>,
): KeyedCursorCodec<TPayload> {
  const maxPrevious = config.maxPreviousKeys ?? 8;
  const maxTokenLength = config.maxTokenLength ?? 2048;
  const materialIds = [config.keys.current, ...(config.keys.previous ?? [])].map((key) => key.key);
  const current = importUtf8Min16Key(config.keys.current, config.messages.invalidKey);
  const previous = (config.keys.previous ?? []).map((key) => ({
    ...importUtf8Min16Key(key, config.messages.invalidKey),
    lastIssuedAt: parseCursorTimestamp(key.lastIssuedAt),
    retainUntil: parseCursorTimestamp(key.retainUntil),
  }));
  if (previous.length > maxPrevious) throw new Error(config.messages.tooManyKeys);
  const ids = new Set<string>();
  const materials = new Set<string>();
  for (const [index, key] of [current, ...previous].entries()) {
    const material = materialIds[index]!;
    if (ids.has(key.id) || materials.has(material)) throw new Error(config.messages.uniqueKeys);
    ids.add(key.id);
    materials.add(material);
  }
  for (const key of previous) {
    if (key.retainUntil - key.lastIssuedAt < config.ttlMs) throw new Error(config.messages.retention);
  }
  let destroyed = false;
  const assertLive = (): void => {
    if (destroyed) throw config.invalid();
  };
  const sign = (unsigned: unknown): string => {
    assertLive();
    const payload = config.validate({ ...(unsigned as object), keyVersion: current.id });
    const { body } = encodeCanonicalCursorBody(payload);
    const signed = `${current.id}.${body}`;
    return `${signed}.${hmacSha256Base64Url(current.key, signed)}`;
  };
  return {
    activeKeyId: current.id,
    sign,
    seal: sign,
    verify(token, now) {
      try {
        assertLive();
        if (typeof token !== 'string' || token.length < 1 || token.length > maxTokenLength) throw new Error();
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error();
        const [keyId, body, signature] = parts as [string, string, string];
        if (!isCursorKeyId(keyId) || !BODY_CHARSET.test(body) || !HMAC_SIGNATURE_CHARSET.test(signature)) {
          throw new Error();
        }
        const nowMs = now.getTime();
        if (!Number.isFinite(nowMs)) throw new Error();
        const previousKey = previous.find((candidate) => candidate.id === keyId);
        const key = keyId === current.id
          ? current
          : previousKey && nowMs < previousKey.retainUntil ? previousKey : undefined;
        if (!key || !timingSafeEqualText(signature, hmacSha256Base64Url(key.key, `${keyId}.${body}`))) {
          throw new Error();
        }
        const canonical = decodeCanonicalCursorBody(body);
        const payload = config.validate(JSON.parse(canonical));
        const record = asIssuedPayload(payload);
        if (canonicalJson(payload) !== canonical || record.keyVersion !== keyId) throw new Error();
        const issuedAt = parseCursorTimestamp(record.issuedAt);
        const expiresAt = parseCursorTimestamp(record.expiresAt);
        if (
          issuedAt > nowMs
          || issuedAt > expiresAt
          || expiresAt - issuedAt > config.ttlMs
          || nowMs >= expiresAt
        ) throw new Error();
        if (
          previousKey && keyId !== current.id
          && (issuedAt > previousKey.lastIssuedAt || expiresAt > previousKey.retainUntil)
        ) throw new Error();
        return payload;
      } catch {
        throw config.invalid();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const key of [current, ...previous]) key.key.fill(0);
    },
    encodedLength(payload) {
      return encodeKeyedHmacToken(current.id, payload).length;
    },
  };
}

function createHmacDerivedCodec<TPayload>(
  config: HmacDerivedCursorConfig<TPayload>,
): KeyedCursorCodec<TPayload> {
  if (!validDerivedKey(config.keys.current)) throw new TypeError(config.messages.invalidCurrent);
  const ids = new Set([config.keys.current.id]);
  const current = {
    id: config.keys.current.id,
    key: deriveHmacPurposeKey(config.keys.current.key, config.hmac.purpose),
  };
  const previous = (config.keys.previous ?? []).map((candidate) => {
    if (!validDerivedKey(candidate) || ids.has(candidate.id)) throw new TypeError(config.messages.uniqueIds);
    ids.add(candidate.id);
    const retainUntilMs = candidate.retainUntil === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(candidate.retainUntil);
    if (!Number.isFinite(retainUntilMs) && candidate.retainUntil !== undefined) {
      throw new TypeError(config.messages.invalidRetainUntil);
    }
    return {
      id: candidate.id,
      key: deriveHmacPurposeKey(candidate.key, config.hmac.purpose),
      retainUntilMs,
    };
  });
  const sign = (payload: unknown): string => {
    config.validate(payload);
    const { body } = encodeCanonicalCursorBody(payload);
    return `${current.id}.${body}.${hmacSha256Base64Url(current.key, body)}`;
  };
  return {
    activeKeyId: current.id,
    sign,
    seal: sign,
    verify(token, now) {
      try {
        if (token.length === 0 || token.length > 2048) throw new Error();
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error();
        const [keyId, encoded, supplied] = parts as [string, string, string];
        const previousKey = previous.find((entry) => entry.id === keyId);
        const key = keyId === current.id ? current : previousKey;
        if (!key || (previousKey !== undefined && now.getTime() >= previousKey.retainUntilMs)) {
          throw new Error();
        }
        const expected = Buffer.from(hmacSha256Base64Url(key.key, encoded));
        const actual = Buffer.from(supplied);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        const payload = config.validate(parsed);
        if (now.getTime() >= Date.parse(asIssuedPayload(payload).expiresAt)) throw new Error();
        return payload;
      } catch {
        throw config.invalid();
      }
    },
    destroy() {},
    encodedLength(payload) {
      return encodeKeyedHmacToken(current.id, payload).length;
    },
  };
}

function createHmacEditorCodec<TPayload>(
  config: HmacEditorCursorConfig<TPayload>,
): KeyedCursorCodec<TPayload> {
  const observe = (metric: EditorCursorObserveMetric): void => {
    try {
      config.hmac.observe?.(metric);
    } catch {
      // Telemetry must not change cursor issuance or verification semantics.
    }
  };
  const reject = (metric: EditorCursorRejectMetric): never => {
    observe(metric);
    throw config.invalid();
  };
  const current = {
    ...normalizeEditorKey(config.keys.current, 'current'),
    kind: 'current' as const,
  };
  const previous = (config.keys.previous ?? []).map((key, index) => ({
    ...normalizeEditorKey(key, `previous[${index}]`),
    kind: 'previous' as const,
    lastIssuedAtMs: assertEditorTimestamp(key.lastIssuedAt, `previous[${index}].lastIssuedAt`),
    retainUntilMs: assertEditorTimestamp(key.retainUntil, `previous[${index}].retainUntil`),
  }));
  const maxPrevious = config.hmac.maxPreviousKeys ?? 8;
  if (previous.length > maxPrevious) {
    throw new Error(`product editor cursor supports at most ${maxPrevious} previous keys`);
  }
  const issuanceFormat = config.hmac.issuanceFormat ?? 'keyed';
  if (issuanceFormat !== 'legacy' && issuanceFormat !== 'keyed') {
    throw new Error('product editor cursor issuance format must be legacy or keyed');
  }
  const legacyAcceptUntilMs = config.hmac.legacyAcceptUntil === undefined
    ? undefined
    : assertEditorTimestamp(config.hmac.legacyAcceptUntil, 'legacyAcceptUntil');
  if (issuanceFormat === 'legacy' && legacyAcceptUntilMs === undefined) {
    throw new Error('product editor cursor legacy issuance requires a bounded acceptance deadline');
  }
  const keyIds = new Set([current.id]);
  const keyMaterial = new Set([current.key]);
  for (const key of previous) {
    if (keyIds.has(key.id)) throw new Error('product editor cursor key IDs must be unique');
    if (keyMaterial.has(key.key)) {
      throw new Error('product editor cursor key material must not be reused across key IDs');
    }
    keyIds.add(key.id);
    keyMaterial.add(key.key);
    if (key.retainUntilMs - key.lastIssuedAtMs < config.ttlMs) {
      throw new Error('product editor cursor previous key retention must cover maximum cursor TTL');
    }
  }
  const encodeBody = (payload: TPayload): { readonly body: string; readonly canonical: string } => {
    return encodeCanonicalCursorBody(config.validate(payload));
  };
  const sign = (payload: unknown): string => {
    const typed = config.validate(payload);
    const { body, canonical } = encodeCanonicalCursorBody(typed);
    if (issuanceFormat === 'legacy') {
      let expiresAt: number;
      try {
        expiresAt = parseCursorTimestamp(asIssuedPayload(typed).expiresAt);
      } catch {
        throw config.invalid();
      }
      if (legacyAcceptUntilMs === undefined || expiresAt > legacyAcceptUntilMs) throw config.invalid();
      observe('issued_legacy');
      return `${body}${hmacSha256Base64Url(current.key, canonical)}`;
    }
    const signed = `${current.id}.${body}`;
    observe('issued');
    return `${signed}.${hmacSha256Base64Url(current.key, signed)}`;
  };
  return {
    activeKeyId: current.id,
    sign,
    seal: sign,
    encodedLength(payload) {
      const bodyLength = encodeBody(payload).body.length;
      return issuanceFormat === 'legacy'
        ? bodyLength + HMAC_SIGNATURE_B64URL_LENGTH
        : current.id.length + bodyLength + HMAC_SIGNATURE_B64URL_LENGTH + 2;
    },
    verify(token, now) {
      if (typeof token !== 'string') return reject('rejected_malformed_token');
      const parts = token.split('.');
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return reject('rejected_invalid_payload');

      if (parts.length === 1) {
        if (token.length <= HMAC_SIGNATURE_B64URL_LENGTH || !BODY_CHARSET.test(token)) {
          return reject('rejected_malformed_token');
        }
        if (legacyAcceptUntilMs === undefined || nowMs >= legacyAcceptUntilMs) {
          return reject('rejected_legacy_disabled');
        }
        const legacySignature = token.slice(-HMAC_SIGNATURE_B64URL_LENGTH);
        const legacyBody = token.slice(0, -HMAC_SIGNATURE_B64URL_LENGTH);
        const canonical = decodeEditorBody(legacyBody, reject);
        const candidates = [
          current,
          ...previous.filter((candidate) => nowMs < candidate.retainUntilMs),
        ];
        const matches = candidates.map((candidate) => timingSafeEqualText(
          legacySignature,
          hmacSha256Base64Url(candidate.key, canonical),
        ));
        const matchIndex = matches.findIndex(Boolean);
        if (matchIndex < 0) return reject('rejected_bad_signature');
        const selected = candidates[matchIndex]!;
        const payload = verifyEditorPayload(canonical, nowMs, config, reject);
        if (selected.kind === 'previous') {
          const issuedAt = parseCursorTimestamp(asIssuedPayload(payload).issuedAt);
          const expiresAt = parseCursorTimestamp(asIssuedPayload(payload).expiresAt);
          if (issuedAt > selected.lastIssuedAtMs || expiresAt > selected.retainUntilMs) {
            return reject('rejected_invalid_payload');
          }
        }
        observe('verified_legacy');
        return payload;
      }

      if (parts.length !== 3) return reject('rejected_malformed_token');
      const [keyId, body, signature] = parts as [string, string, string];
      if (
        !isCursorKeyId(keyId)
        || !body
        || signature.length !== HMAC_SIGNATURE_B64URL_LENGTH
        || !BODY_CHARSET.test(body)
        || !BODY_CHARSET.test(signature)
      ) {
        return reject('rejected_malformed_token');
      }
      const knownPrevious = previous.find((candidate) => candidate.id === keyId);
      const selected = keyId === current.id
        ? current
        : knownPrevious && nowMs < knownPrevious.retainUntilMs ? knownPrevious : undefined;
      if (!selected) return reject(knownPrevious ? 'rejected_retired_key' : 'rejected_unknown_key');
      const canonical = decodeEditorBody(body, reject);
      if (!timingSafeEqualText(signature, hmacSha256Base64Url(selected.key, `${keyId}.${body}`))) {
        return reject('rejected_bad_signature');
      }
      const payload = verifyEditorPayload(canonical, nowMs, config, reject);
      const issuedAt = parseCursorTimestamp(asIssuedPayload(payload).issuedAt);
      const expiresAt = parseCursorTimestamp(asIssuedPayload(payload).expiresAt);
      if (selected.kind === 'previous' && (issuedAt > selected.lastIssuedAtMs || expiresAt > selected.retainUntilMs)) {
        return reject('rejected_invalid_payload');
      }
      observe(keyId === current.id ? 'verified_current' : 'verified_previous');
      return payload;
    },
    destroy() {},
  };
}

function createHmacPrefixedCodec<TPayload>(
  config: HmacPrefixedCursorConfig<TPayload>,
): KeyedCursorCodec<TPayload> {
  const maxTokenLength = config.maxTokenLength ?? 2048;
  const encoding = config.hmac.encoding ?? 'ascii';
  const prefix = config.hmac.prefix;
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9]{1,16}$/u.test(prefix)) {
    throw new Error('prefixed cursor prefix must be 1-16 alphanumeric characters');
  }
  const raw = [config.keys.current, ...(config.keys.previous ?? [])];
  if (
    new Set(raw.map((key) => key.id)).size !== raw.length
    || new Set(raw.map((key) => key.secret)).size !== raw.length
  ) {
    throw new Error(config.messages.uniqueKeys);
  }
  const imported: ImportedUtf8Key[] = [];
  let current: ImportedUtf8Key;
  let previous: ImportedUtf8Key[];
  try {
    current = importPrefixedHmacKey(config.keys.current, config);
    imported.push(current);
    previous = (config.keys.previous ?? []).map((key) => {
      const importedKey = importPrefixedHmacKey(key, config);
      imported.push(importedKey);
      return importedKey;
    });
  } catch (error) {
    imported.forEach((key) => key.key.fill(0));
    throw error;
  }
  let destroyed = false;
  const assertLive = (): void => {
    if (destroyed) throw config.invalid();
  };
  const sign = (unsigned: unknown): string => {
    assertLive();
    const payload = config.validate(unsigned);
    const { body } = encodeCanonicalCursorBody(payload);
    const signed = `${prefix}.${current.id}.${body}`;
    return `${signed}.${hmacSha256Base64Url(current.key, signed, encoding)}`;
  };
  return {
    activeKeyId: current.id,
    sign,
    seal: sign,
    verify(token) {
      try {
        assertLive();
        if (typeof token !== 'string' || token.length < 1 || token.length > maxTokenLength) throw new Error();
        const parts = token.split('.');
        if (parts.length !== 4) throw new Error();
        const [gotPrefix, keyId, body, signature] = parts as [string, string, string, string];
        if (
          gotPrefix !== prefix
          || !isCursorKeyId(keyId)
          || !BODY_CHARSET.test(body)
          || !HMAC_SIGNATURE_CHARSET.test(signature)
        ) throw new Error();
        const key = keyId === current.id ? current : previous.find((candidate) => candidate.id === keyId);
        if (!key) throw new Error();
        const signed = `${prefix}.${keyId}.${body}`;
        const expectedMac = Buffer.from(hmacSha256Base64Url(key.key, signed, encoding), 'base64url');
        const suppliedMac = Buffer.from(signature, 'base64url');
        const macValid = timingSafeEqualBytes(suppliedMac, expectedMac);
        expectedMac.fill(0);
        suppliedMac.fill(0);
        if (!macValid) throw new Error();
        return config.validate(JSON.parse(decodeCanonicalCursorBody(body)));
      } catch {
        throw config.invalid();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const key of [current, ...previous]) key.key.fill(0);
    },
    encodedLength(payload) {
      const { body } = encodeCanonicalCursorBody(payload);
      return `${prefix}.${current.id}.${body}.${'x'.repeat(HMAC_SIGNATURE_B64URL_LENGTH)}`.length;
    },
  };
}

function importPrefixedHmacKey(
  value: KeyedCursorKeyInput,
  config: Pick<HmacPrefixedCursorConfig<unknown>, 'hmac' | 'messages'>,
): ImportedUtf8Key {
  const imported = importAesKey(value, config.messages);
  try {
    return {
      id: imported.id,
      key: deriveHkdfSha256(imported.secret, config.hmac.hkdfSalt, config.hmac.purpose),
    };
  } finally {
    imported.secret.fill(0);
  }
}

function createAesGcmCodec<TPayload>(config: AesGcmCursorConfig<TPayload>): KeyedCursorCodec<TPayload> {
  const maxPrevious = config.maxPreviousKeys ?? 8;
  const maxTokenLength = config.maxTokenLength ?? 2048;
  const imported: ImportedAesKey[] = [];
  const fail = (message: string): never => {
    imported.forEach((key) => key.secret.fill(0));
    throw new Error(message);
  };
  let active: ImportedAesKey;
  let retained: (ImportedAesKey & { readonly lastIssuedAt: number; readonly retainUntil: number })[];
  try {
    active = importAesKey(config.keys.current, config.messages);
    imported.push(active);
    retained = (config.keys.previous ?? []).map((key) => {
      const importedKey = importAesKey(key, config.messages);
      imported.push(importedKey);
      return {
        ...importedKey,
        lastIssuedAt: parseCursorTimestamp(key.lastIssuedAt, 'rfc3339-millis'),
        retainUntil: parseCursorTimestamp(key.retainUntil, 'rfc3339-millis'),
      };
    });
  } catch (error) {
    imported.forEach((key) => key.secret.fill(0));
    throw error;
  }
  if (retained.length > maxPrevious) fail(config.messages.tooManyKeys);
  const all = [active, ...retained];
  if (
    new Set(all.map((key) => key.id)).size !== all.length
    || new Set(all.map((key) => key.secret.toString('base64'))).size !== all.length
  ) {
    fail(config.messages.uniqueKeys);
  }
  if (retained.some((key) => key.retainUntil - key.lastIssuedAt < config.ttlMs)) {
    fail(config.messages.retention);
  }
  let destroyed = false;
  const seal = (unsigned: unknown): string => {
    try {
      if (destroyed) throw new Error();
      const payload = config.validate({ ...(unsigned as object), keyVersion: active.id });
      const iv = randomBytes(12);
      const key = deriveHkdfSha256(active.secret, config.hkdfSalt, config.purpose);
      try {
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(`${config.prefix}.${active.id}.${config.purpose}`));
        const ciphertext = Buffer.concat([cipher.update(canonicalJson(payload), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        try {
          const token = [
            config.prefix,
            active.id,
            iv.toString('base64url'),
            ciphertext.toString('base64url'),
            tag.toString('base64url'),
          ].join('.');
          if (token.length > maxTokenLength) throw new Error();
          return token;
        } finally {
          ciphertext.fill(0);
          tag.fill(0);
        }
      } finally {
        key.fill(0);
        iv.fill(0);
      }
    } catch {
      throw config.invalid();
    }
  };
  return {
    activeKeyId: active.id,
    sign: seal,
    seal,
    verify(token, now) {
      try {
        if (destroyed || typeof token !== 'string' || token.length > maxTokenLength) throw new Error();
        const [prefix, keyId, ivText, ciphertextText, tagText, ...extra] = token.split('.');
        if (
          extra.length
          || prefix !== config.prefix
          || !isCursorKeyId(keyId)
          || !AES_IV_CHARSET.test(ivText ?? '')
          || !BODY_CHARSET.test(ciphertextText ?? '')
          || !AES_TAG_CHARSET.test(tagText ?? '')
        ) throw new Error();
        const nowMs = now.getTime();
        if (!Number.isFinite(nowMs)) throw new Error();
        const old = retained.find((key) => key.id === keyId);
        const selected = active.id === keyId ? active : old && nowMs < old.retainUntil ? old : undefined;
        if (!selected) throw new Error();
        const iv = decodeCanonicalBase64Url(ivText!);
        const ciphertext = decodeCanonicalBase64Url(ciphertextText!);
        const tag = decodeCanonicalBase64Url(tagText!);
        const key = deriveHkdfSha256(selected.secret, config.hkdfSalt, config.purpose);
        let plain: Buffer;
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAAD(Buffer.from(`${config.prefix}.${keyId}.${config.purpose}`));
          decipher.setAuthTag(tag);
          plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        } finally {
          key.fill(0);
          iv.fill(0);
          ciphertext.fill(0);
          tag.fill(0);
        }
        try {
          const text = plain.toString('utf8');
          const payload = config.validate(JSON.parse(text));
          const record = asIssuedPayload(payload);
          if (canonicalJson(payload) !== text || record.keyVersion !== keyId) throw new Error();
          const issued = parseCursorTimestamp(record.issuedAt, 'rfc3339-millis');
          const expires = parseCursorTimestamp(record.expiresAt, 'rfc3339-millis');
          if (issued > nowMs || expires <= nowMs || expires - issued !== config.ttlMs) throw new Error();
          if (old && (issued > old.lastIssuedAt || expires > old.retainUntil)) throw new Error();
          return payload;
        } finally {
          plain.fill(0);
        }
      } catch {
        throw config.invalid();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      all.forEach((key) => key.secret.fill(0));
    },
    encodedLength() {
      return 0;
    },
  };
}

interface ImportedUtf8Key {
  readonly id: string;
  readonly key: Buffer;
}

interface ImportedAesKey {
  readonly id: string;
  readonly secret: Buffer;
}

function importUtf8Min16Key(
  key: { readonly id: string; readonly key: string },
  invalidKey: string,
): ImportedUtf8Key {
  if (!key || !isCursorKeyId(key.id) || typeof key.key !== 'string' || key.key.length < 16) {
    throw new Error(invalidKey);
  }
  return { id: key.id, key: Buffer.from(key.key, 'utf8') };
}

function importAesKey(
  value: KeyedCursorKeyInput,
  messages: Pick<KeyedCursorPolicyMessages, 'invalidKey' | 'canonicalSecret'>,
): ImportedAesKey {
  if (!value || !isCursorKeyId(value.id) || typeof value.secret !== 'string') {
    throw new Error(messages.invalidKey);
  }
  const secret = Buffer.from(value.secret, 'base64');
  if (secret.length < 32 || secret.toString('base64') !== value.secret) {
    secret.fill(0);
    throw new Error(messages.canonicalSecret ?? messages.invalidKey);
  }
  return { id: value.id, secret };
}

function validDerivedKey(value: { readonly id: string; readonly key: string } | undefined): boolean {
  return Boolean(value && KEY_ID_PATTERN.test(value.id) && value.key.trim().length >= 16);
}

function normalizeEditorKey(
  value: { readonly id: string; readonly key: string },
  field: string,
): { readonly id: string; readonly key: string } {
  if (!value || typeof value !== 'object' || !isCursorKeyId(value.id)) {
    throw new Error(`product editor cursor ${field}.id must be a valid key ID`);
  }
  if (typeof value.key !== 'string' || value.key.length < 1) {
    throw new Error(`product editor cursor ${field}.key must be a non-empty string`);
  }
  return Object.freeze({ id: value.id, key: value.key });
}

function assertEditorTimestamp(value: string, field: string): number {
  try {
    return parseCursorTimestamp(value);
  } catch {
    throw new Error(
      `product editor cursor ${field} must be canonical RFC 3339 UTC (YYYY-MM-DDTHH:mm:ss[.sss]Z)`,
    );
  }
}

function decodeEditorBody(body: string, reject: (metric: EditorCursorRejectMetric) => never): string {
  try {
    return decodeCanonicalCursorBody(body);
  } catch {
    return reject('rejected_malformed_token');
  }
}

function verifyEditorPayload<TPayload>(
  canonical: string,
  nowMs: number,
  config: HmacEditorCursorConfig<TPayload>,
  reject: (metric: EditorCursorRejectMetric) => never,
): TPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical) as unknown;
  } catch {
    return reject('rejected_invalid_payload');
  }
  let payload: TPayload;
  try {
    payload = config.validate(parsed);
  } catch {
    return reject('rejected_invalid_payload');
  }
  if (canonicalJson(payload) !== canonical) return reject('rejected_invalid_payload');
  let issuedAt: number;
  let expiresAt: number;
  try {
    const record = asIssuedPayload(payload);
    issuedAt = parseCursorTimestamp(record.issuedAt);
    expiresAt = parseCursorTimestamp(record.expiresAt);
  } catch {
    return reject('rejected_invalid_payload');
  }
  if (issuedAt > expiresAt || expiresAt - issuedAt > config.ttlMs) return reject('rejected_invalid_payload');
  if (nowMs >= expiresAt) return reject('rejected_expired');
  return payload;
}

function asIssuedPayload(value: unknown): {
  readonly keyVersion?: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
} {
  if (typeof value !== 'object' || value === null) throw new Error();
  const record = value as { keyVersion?: unknown; issuedAt?: unknown; expiresAt?: unknown };
  if (typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string') throw new Error();
  return record as { readonly keyVersion?: string; readonly issuedAt: string; readonly expiresAt: string };
}

function encodeKeyedHmacToken(keyId: string, payload: unknown): string {
  const { body } = encodeCanonicalCursorBody(payload);
  return `${keyId}.${body}.${'x'.repeat(HMAC_SIGNATURE_B64URL_LENGTH)}`;
}
