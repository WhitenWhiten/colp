import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { SyncPullEvent, SyncPullEventV02 } from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../../identity/index.js';

export const SYNC_PULL_STREAM_KIND_ORDER = Object.freeze({ operation: 0, conflict: 1 } as const);
export const INITIAL_SYNC_PULL_PURGE_BOUNDARY = Object.freeze({
  commitOrdinal: '0', streamKind: 'operation' as const, stableId: '',
});

export type SyncPullStreamKind = keyof typeof SYNC_PULL_STREAM_KIND_ORDER;
export interface SyncPullTuple {
  readonly commitOrdinal: string;
  readonly streamKind: SyncPullStreamKind;
  readonly stableId: string;
}

export interface SyncPullCursorContext {
  readonly replicaId: string;
  readonly collectionId: string;
  readonly leaseGeneration: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly protocolVersion: string;
  readonly policyRevision: string;
  readonly purgeBoundary: SyncPullTuple;
  readonly limit: number;
}

export interface SyncPullCursorScope extends SyncPullCursorContext {
  readonly tuple: SyncPullTuple;
}

export interface SyncPullCursorAnchor {
  readonly commitOrdinal: string;
  readonly streamKind: SyncPullStreamKind;
  readonly stableIdHash: string;
}

export interface SyncPullCursorKeyConfig {
  readonly id: string;
  readonly secret: string;
}

export interface SyncPullCursorKeyringConfig {
  readonly active: SyncPullCursorKeyConfig;
  readonly retained: readonly SyncPullCursorKeyConfig[];
  readonly ttlMs: number;
  readonly now?: () => number;
}

export type SyncPullCursorVerification =
  | { readonly valid: true; readonly anchor: SyncPullCursorAnchor; readonly expiresAt: number }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' | 'sync_cursor_expired' };

export interface SyncPullCursorKeyring {
  readonly activeKeyId: string;
  readonly destroyed: boolean;
  sign(scope: SyncPullCursorScope, expiresAt?: number): string;
  verify(cursor: string, context: SyncPullCursorContext): SyncPullCursorVerification;
  destroy(): void;
}

/**
 * FIX-L-035: minimal digest-only facts kept as signed lineage after the cursor
 * evidence and recovery proof are cleaned. Contains the cursor digest, the
 * issuance binding, the last tuple and the cursor expiry — never the full
 * signed cursor payload or any secret material.
 */
export interface SyncPullCursorLineageFacts {
  readonly cursorDigest: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: string;
  readonly policyRevision: string;
  readonly protocolVersion: '0.1' | '0.2';
  readonly pageLimit: number;
  readonly tuple: SyncPullTuple;
  readonly cursorExpiresAt: number;
}

export type SyncPullCursorLineageVerification =
  | { readonly valid: true; readonly keyId: string }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' };

export interface SyncPullCursorLineageKeyring {
  readonly activeKeyId: string;
  readonly destroyed: boolean;
  sign(facts: SyncPullCursorLineageFacts): string;
  verify(receipt: string, facts: SyncPullCursorLineageFacts): SyncPullCursorLineageVerification;
  destroy(): void;
}

export interface SyncPullCursorLineageKeyringConfig {
  readonly active: SyncPullCursorKeyConfig;
  readonly retained: readonly SyncPullCursorKeyConfig[];
}

export interface SyncPullReadPage {
  readonly events: readonly (SyncPullEvent | SyncPullEventV02)[];
  readonly nextCursor: string;
  readonly nextTuple: SyncPullTuple;
  readonly hasMore: boolean;
  readonly collectionRevision: string;
  readonly protocolVersion?: '0.1' | '0.2';
  readonly cursorReissued?: boolean;
}

export type SyncPullReadErrorCode = 'not_found' | 'invalid_cursor_scope' | 'stale_replica'
  | 'sync_cursor_expired' | 'replica_expired' | 'recovery_required'
  | 'replica_retired' | 'integrity_failure' | 'payload_too_large';
export class SyncPullReadError extends Error {
  constructor(readonly code: SyncPullReadErrorCode) {
    super(`Sync Pull read denied: ${code}`);
    this.name = 'SyncPullReadError';
  }
}

export interface SyncPullReadInput {
  readonly credential: VerifiedExtensionCredential;
  readonly sessionId: string;
  /** Transport Origin, bound to the durable Session when supplied by HTTP. */
  readonly origin?: string;
  readonly collectionId?: string;
  readonly replicaId?: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SyncPullReadPort {
  read(input: SyncPullReadInput): Promise<SyncPullReadPage>;
}

interface ImportedKey { readonly id: string; readonly tag: string; readonly key: Buffer }
const invalid = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);
const cursorPattern = /^spc2\.([A-Za-z0-9_-]{11})\.([0-9a-z]+)\.([0-9a-z]+)\.([oc])\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/u;
const ordinalPattern = /^(?:0|[1-9][0-9]*)$/u;
const postgresBigintMaximum = 9_223_372_036_854_775_807n;
const contextKeys = new Set([
  'replicaId', 'collectionId', 'leaseGeneration', 'sessionId', 'principalId',
  'protocolVersion', 'policyRevision', 'purgeBoundary', 'limit', 'tuple',
]);

/**
 * Sync Pull cursors stay local. `moduleEdges.sync` allows only `collections`
 * and `identity`; importing `createKeyedCursorCodec` from `commands` is a
 * boundary violation and must not be added. The packed `spc2` wire form
 * (tag + base36 expiry/ordinal + context-bound truncated HMAC) is also not
 * the shared HMAC product / prefixed / derived codec pattern.
 */
export function createSyncPullCursorKeyring(config: SyncPullCursorKeyringConfig): SyncPullCursorKeyring {
  const normalized = normalizeConfig(config);
  const imported = normalized.keys.map(importKey);
  if (new Set(imported.map((key) => key.tag)).size !== imported.length) {
    for (const key of imported) key.key.fill(0);
    throw new Error('Sync Pull cursor key tags must be unique');
  }
  const ttlMs = normalized.ttlMs;
  // normalizeConfig always keeps the active key first, so the first imported key is present.
  const active = imported[0]!;
  const now = config.now ?? Date.now;
  let destroyed = false;
  const keyring: SyncPullCursorKeyring = {
    activeKeyId: active.id,
    get destroyed() { return destroyed; },
    sign(scope, retainedExpiresAt) {
      if (destroyed) throw new Error('Sync Pull cursor keyring is destroyed');
      const issuedAt = now();
      const expiresAt = retainedExpiresAt ?? issuedAt + ttlMs;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(issuedAt + ttlMs)
          || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + ttlMs) {
        throw new Error('Sync Pull cursor clock is invalid');
      }
      const context = validatedContext(scope);
      const tuple = validatedTuple(scope.tuple, true);
      const anchor = { commitOrdinal: tuple.commitOrdinal, streamKind: tuple.streamKind,
        stableIdHash: syncPullStableIdHash(tuple.stableId) };
      const signed = `spc2.${active.tag}.${BigInt(expiresAt).toString(36)}.${BigInt(anchor.commitOrdinal).toString(36)}.${anchor.streamKind === 'operation' ? 'o' : 'c'}.${anchor.stableIdHash}`;
      const mac = cursorMac(active, signed, context);
      if (signed.length + mac.length + 1 > 128) throw new Error('Sync Pull cursor exceeds the protocol opaqueId budget');
      return `${signed}.${mac}`;
    },
    verify(cursor, context) {
      if (destroyed || typeof cursor !== 'string') return invalid;
      const verifiedAt = now();
      if (!Number.isSafeInteger(verifiedAt) || verifiedAt < 0) return invalid;
      const match = cursorPattern.exec(cursor);
      if (!match) return invalid;
      // The match is a successful capture of the full cursor pattern, but each capture
      // group is indexed access, so read them through .at() and guard the undefined case.
      const cursorTag = match.at(1);
      const expiresAtText = match.at(2);
      const ordinalText = match.at(3);
      const streamKindFlag = match.at(4);
      const stableIdHashText = match.at(5);
      const macText = match.at(6);
      if (cursorTag === undefined || expiresAtText === undefined || ordinalText === undefined
          || streamKindFlag === undefined || stableIdHashText === undefined || macText === undefined) return invalid;
      const key = imported.find((candidate) => candidate.tag === cursorTag);
      if (!key) return invalid;
      let contextValue: SyncPullCursorContext;
      try { contextValue = validatedContext(context); } catch { return invalid; }
      const signed = `spc2.${cursorTag}.${expiresAtText}.${ordinalText}.${streamKindFlag}.${stableIdHashText}`;
      const expectedMac = Buffer.from(cursorMac(key, signed, contextValue), 'base64url');
      const suppliedMac = Buffer.from(macText, 'base64url');
      const validMac = suppliedMac.toString('base64url') === macText
        && suppliedMac.length === expectedMac.length && timingSafeEqual(suppliedMac, expectedMac);
      expectedMac.fill(0); suppliedMac.fill(0);
      if (!validMac) return invalid;
      let expiresAtBig: bigint;
      let ordinalBig: bigint;
      try { expiresAtBig = base36BigInt(expiresAtText); ordinalBig = base36BigInt(ordinalText); } catch { return invalid; }
      if (expiresAtBig > BigInt(Number.MAX_SAFE_INTEGER) || ordinalBig > postgresBigintMaximum
          || expiresAtBig.toString(36) !== expiresAtText || ordinalBig.toString(36) !== ordinalText) return invalid;
      const expiresAt = Number(expiresAtBig);
      const anchor = Object.freeze({ commitOrdinal: ordinalBig.toString(),
        streamKind: streamKindFlag === 'o' ? 'operation' as const : 'conflict' as const,
        stableIdHash: stableIdHashText });
      if (expiresAt <= verifiedAt) return Object.freeze({ valid: false, code: 'sync_cursor_expired' });
      return Object.freeze({ valid: true, anchor, expiresAt });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const key of imported) key.key.fill(0);
    },
  };
  return Object.freeze(keyring);
}

interface ImportedLineageKey { readonly id: string; readonly key: Buffer }
const invalidLineage = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);
const lineageReceiptPattern = /^spl1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/u;

/**
 * FIX-L-035: purpose-separated keyring for the digest-only Pull cursor lineage
 * receipts (`spl1.<keyId>.<factsDigest>.<mac>`). Keys rotate independently of
 * the cursor keyring: a receipt stays verifiable while its key is retained,
 * and the receipt authenticates the minimal facts (cursor digest, binding,
 * last tuple, expiry) without ever carrying the cursor payload or a secret.
 * Left local: packed digest MAC, not the shared cursor codec; sync cannot
 * import `commands`.
 */
export function createSyncPullCursorLineageKeyring(
  config: SyncPullCursorLineageKeyringConfig,
): SyncPullCursorLineageKeyring {
  const keys = normalizeLineageKeys(config);
  const activeKey = keys[0];
  if (!activeKey) {
    throw new Error('Sync Pull cursor lineage keyring requires an active key');
  }
  let destroyed = false;
  const keyring: SyncPullCursorLineageKeyring = {
    activeKeyId: activeKey.id,
    get destroyed() { return destroyed; },
    sign(facts) {
      if (destroyed) throw new Error('Sync Pull cursor lineage keyring is destroyed');
      const validated = validateLineageFacts(facts);
      const digest = lineageFactsDigest(validated);
      const signed = `spl1.${activeKey.id}.${digest}`;
      return `${signed}.${lineageReceiptMac(activeKey, signed)}`;
    },
    verify(receipt, facts) {
      if (destroyed || typeof receipt !== 'string') return invalidLineage;
      const match = lineageReceiptPattern.exec(receipt);
      if (!match) return invalidLineage;
      const keyId = match.at(1);
      const digest = match.at(2);
      const macText = match.at(3);
      if (keyId === undefined || digest === undefined || macText === undefined) return invalidLineage;
      const key = keys.find((candidate) => candidate.id === keyId);
      if (!key) return invalidLineage;
      let validated: SyncPullCursorLineageFacts;
      try { validated = validateLineageFacts(facts); } catch { return invalidLineage; }
      if (lineageFactsDigest(validated) !== digest) return invalidLineage;
      const signed = `spl1.${keyId}.${digest}`;
      const expectedMac = Buffer.from(lineageReceiptMac(key, signed), 'base64url');
      const suppliedMac = Buffer.from(macText, 'base64url');
      const valid = suppliedMac.toString('base64url') === macText
        && suppliedMac.length === expectedMac.length && timingSafeEqual(suppliedMac, expectedMac);
      expectedMac.fill(0); suppliedMac.fill(0);
      if (!valid) return invalidLineage;
      return Object.freeze({ valid: true, keyId });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const key of keys) key.key.fill(0);
    },
  };
  return Object.freeze(keyring);
}

function normalizeLineageKeys(config: SyncPullCursorLineageKeyringConfig): readonly ImportedLineageKey[] {
  if (!config || !config.active || !Array.isArray(config.retained)) {
    throw new Error('Sync Pull cursor lineage keyring configuration is required');
  }
  const candidates = [config.active, ...config.retained].map((candidate, index) => {
    if (!candidate || !/^[A-Za-z0-9_-]{1,64}$/u.test(candidate.id)
        || /(?:recovery|publication|editor|snapshot)/iu.test(candidate.id)) {
      throw new Error(`Sync Pull cursor lineage key ${index} has an invalid or cross-purpose id`);
    }
    const bytes = Buffer.from(candidate.secret, 'base64');
    const valid = bytes.length >= 32 && bytes.toString('base64') === candidate.secret;
    bytes.fill(0);
    if (!valid) throw new Error(`Sync Pull cursor lineage key ${index} requires canonical base64 material`);
    return Object.freeze({ id: candidate.id, secret: candidate.secret });
  });
  if (new Set(candidates.map((key) => key.id)).size !== candidates.length) {
    throw new Error('Sync Pull cursor lineage key ids must be unique');
  }
  if (new Set(candidates.map((key) => key.secret)).size !== candidates.length) {
    throw new Error('Sync Pull cursor lineage key material must not be reused');
  }
  return candidates.map(importLineageKey);
}

function importLineageKey(config: SyncPullCursorKeyConfig): ImportedLineageKey {
  const secret = Buffer.from(config.secret, 'base64');
  try {
    return Object.freeze({ id: config.id,
      key: Buffer.from(hkdfSync(
        'sha256', secret, Buffer.from('known/sync/pull-cursor-lineage/v1'),
        Buffer.from('sync-pull-lineage'), 32,
      )) });
  } finally { secret.fill(0); }
}

function validateLineageFacts(facts: SyncPullCursorLineageFacts): SyncPullCursorLineageFacts {
  if (!isRecord(facts) || typeof facts.cursorDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(facts.cursorDigest)) {
    throw new TypeError('Sync Pull cursor lineage digest is invalid');
  }
  const validated = {
    cursorDigest: facts.cursorDigest,
    sessionId: nonEmpty(facts.sessionId),
    accountId: nonEmpty(facts.accountId),
    collectionId: nonEmpty(facts.collectionId),
    replicaId: nonEmpty(facts.replicaId),
    leaseGeneration: ordinal(facts.leaseGeneration),
    policyRevision: nonEmpty(facts.policyRevision),
    protocolVersion: facts.protocolVersion,
    pageLimit: facts.pageLimit,
    tuple: validatedTuple(facts.tuple, true),
    cursorExpiresAt: facts.cursorExpiresAt,
  };
  if (validated.protocolVersion !== '0.1' && validated.protocolVersion !== '0.2') {
    throw new TypeError('Sync Pull cursor lineage protocol is invalid');
  }
  if (!Number.isSafeInteger(validated.cursorExpiresAt) || validated.cursorExpiresAt < 1) {
    throw new TypeError('Sync Pull cursor lineage expiry is invalid');
  }
  if (!Number.isSafeInteger(validated.pageLimit) || validated.pageLimit < 1
      || validated.pageLimit > 1_000) {
    throw new TypeError('Sync Pull cursor lineage limit is invalid');
  }
  return Object.freeze(validated);
}

function lineageFactsDigest(facts: SyncPullCursorLineageFacts): string {
  return createHash('sha256').update(JSON.stringify([
    facts.cursorDigest, facts.sessionId, facts.accountId, facts.collectionId, facts.replicaId,
    facts.leaseGeneration, facts.policyRevision, facts.protocolVersion, facts.pageLimit,
    facts.tuple.commitOrdinal, facts.tuple.streamKind, facts.tuple.stableId, facts.cursorExpiresAt,
  ]), 'utf8').digest('base64url');
}

function lineageReceiptMac(key: ImportedLineageKey, signed: string): string {
  return createHmac('sha256', key.key).update(signed, 'ascii').digest().subarray(0, 16).toString('base64url');
}

function normalizeConfig(config: SyncPullCursorKeyringConfig): {
  readonly keys: readonly SyncPullCursorKeyConfig[]; readonly ttlMs: number;
} {
  if (!config || !config.active || !Array.isArray(config.retained)
      || !Number.isSafeInteger(config.ttlMs) || config.ttlMs < 1) {
    throw new Error('Sync Pull cursor keyring configuration is required');
  }
  const keys = [config.active, ...config.retained].map((candidate, index) => {
    if (!candidate || !/^[A-Za-z0-9_-]{1,64}$/u.test(candidate.id)) {
      throw new Error(`Sync Pull cursor key ${index} has an invalid id`);
    }
    const bytes = Buffer.from(candidate.secret, 'base64');
    const valid = bytes.length >= 32 && bytes.toString('base64') === candidate.secret;
    bytes.fill(0);
    if (!valid) throw new Error(`Sync Pull cursor key ${index} requires canonical base64 material`);
    return Object.freeze({ id: candidate.id, secret: candidate.secret });
  });
  if (new Set(keys.map((key) => key.id)).size !== keys.length) {
    throw new Error('Sync Pull cursor key ids must be unique');
  }
  if (new Set(keys.map((key) => key.secret)).size !== keys.length) {
    throw new Error('Sync Pull cursor key material must not be reused');
  }
  return Object.freeze({ keys: Object.freeze(keys), ttlMs: config.ttlMs });
}

function importKey(config: SyncPullCursorKeyConfig): ImportedKey {
  const secret = Buffer.from(config.secret, 'base64');
  try {
    return Object.freeze({ id: config.id,
      tag: createHash('sha256').update(config.id, 'utf8').digest('base64url').slice(0, 11),
      key: Buffer.from(hkdfSync(
      'sha256', secret, Buffer.from('known/sync/pull-cursor/v1'), Buffer.from('sync-pull'), 32,
    )) });
  } finally { secret.fill(0); }
}

export function syncPullStableIdHash(stableId: string): string {
  return createHash('sha256').update(stableId, 'utf8').digest('base64url');
}

function cursorMac(key: ImportedKey, signed: string, context: SyncPullCursorContext): string {
  return createHmac('sha256', key.key).update(signed, 'ascii').update('\0', 'ascii')
    .update(canonicalJson({ version: 2, comparator: 'commit-ordinal-kind-stable-id-sha256-c-v1',
      keyVersion: key.id, purpose: 'sync-pull', ...context }), 'utf8').digest().subarray(0, 16).toString('base64url');
}

function base36BigInt(value: string): bigint {
  let result = 0n;
  for (const character of value) {
    const digit = BigInt(parseInt(character, 36));
    if (digit < 0n || digit >= 36n) throw new TypeError('invalid base36');
    result = result * 36n + digit;
  }
  return result;
}

function validatedContext(value: SyncPullCursorContext): SyncPullCursorContext {
  if (!isRecord(value)) throw new TypeError('Sync Pull cursor context is invalid');
  if (Object.keys(value).some((key) => !contextKeys.has(key))) {
    throw new TypeError('Sync Pull cursor context has an unknown binding');
  }
  const context = {
    replicaId: nonEmpty(value.replicaId), collectionId: nonEmpty(value.collectionId),
    leaseGeneration: ordinal(value.leaseGeneration), sessionId: nonEmpty(value.sessionId),
    principalId: nonEmpty(value.principalId), protocolVersion: nonEmpty(value.protocolVersion),
    policyRevision: nonEmpty(value.policyRevision),
    purgeBoundary: validatedTuple(value.purgeBoundary, true), limit: value.limit,
  };
  if (!Number.isSafeInteger(context.limit) || context.limit < 1 || context.limit > 1_000) {
    throw new TypeError('Sync Pull cursor limit is invalid');
  }
  return Object.freeze(context);
}

function validatedTuple(value: unknown, initialAllowed: boolean): SyncPullTuple {
  if (!isRecord(value) || Object.keys(value).length !== 3
      || !['commitOrdinal', 'streamKind', 'stableId'].every((key) => Object.hasOwn(value, key))
      || !Object.hasOwn(SYNC_PULL_STREAM_KIND_ORDER, String(value.streamKind))) {
    throw new TypeError('Sync Pull cursor tuple is invalid');
  }
  const tuple = { commitOrdinal: ordinal(value.commitOrdinal), streamKind: value.streamKind as SyncPullStreamKind,
    stableId: typeof value.stableId === 'string' ? value.stableId : '' };
  const initial = initialAllowed && tuple.commitOrdinal === '0'
    && tuple.streamKind === 'operation' && tuple.stableId === '';
  if (tuple.stableId.length > 512 || (tuple.commitOrdinal === '0' ? !initial : !tuple.stableId)) {
    throw new TypeError('Sync Pull cursor tuple stable ID is invalid');
  }
  return Object.freeze(tuple);
}

function ordinal(value: unknown): string {
  if (typeof value !== 'string' || !ordinalPattern.test(value)
      || value.length > 19 || BigInt(value) > postgresBigintMaximum) {
    throw new TypeError('Sync Pull cursor ordinal is invalid');
  }
  return value;
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new TypeError('Sync Pull cursor binding is invalid');
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Sync Pull cursor scope is not canonical JSON');
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
