import { createHash } from 'node:crypto';
import type { CreateSyncSessionInput, VerifiedSyncSession } from '@know-n/colp/sync';
import {
  isVerifiedExtensionCredential,
  type VerifiedExtensionCredential,
} from '../identity/index.js';
import {
  validateReplicaBindingFacts,
  validateProtocolSafeReplicaId,
  type ReplicaBindingFacts,
} from './replica-facts.js';

export type SyncSessionIssueErrorCode =
  | 'credential_invalid'
  | 'not_found'
  | 'stale_replica'
  | 'replica_expired'
  | 'replica_recovery_required'
  | 'replica_retired'
  | 'idempotency_key_reuse'
  | 'session_expired'
  | 'session_revoked'
  | 'integrity_failure';

/**
 * FIX-L-036 (SYNC-R20): the single source of truth for Replica lease duration
 * bounds, shared by first-install registration, renewal/issue options,
 * configuration parsing and startup validation. First-install registration
 * previously hard-rejected leases above one day while renewal and config
 * allowed up to thirty days, so a configured lease above 86400 seconds made
 * new-device registration fail with invalid_document.
 */
export const REPLICA_LEASE_BOUNDS = Object.freeze({
  minSeconds: 60,
  maxSeconds: 2_592_000,
} as const);

/**
 * FIX-L-034 (SYNC-R18 Partial): the Sync tombstone retention protocol floor is
 * thirty days. Configuration parsing, the Publication Manifest and the
 * database CHECK all share this single source of truth; a shorter value is a
 * versioned product-contract change, never a silent relaxation.
 */
export const TOMBSTONE_RETENTION_BOUNDS = Object.freeze({
  minSeconds: 2_592_000,
} as const);

export class SyncSessionIssueError extends Error {
  readonly code: SyncSessionIssueErrorCode;
  readonly snapshotUrl: string | null;

  constructor(code: SyncSessionIssueErrorCode, snapshotUrl: string | null = null) {
    super(`Sync Session request denied: ${code}`);
    this.name = 'SyncSessionIssueError';
    this.code = code;
    this.snapshotUrl = snapshotUrl;
  }
}

export interface SyncSessionIssueInput {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly expectedLeaseGeneration: string;
  readonly expectedLifecycleRevision: string;
  readonly binding: ReplicaBindingFacts;
  readonly requestedScopes: readonly ('sync:bootstrap' | 'sync:pull' | 'sync:push')[];
  readonly origin: string;
  readonly protocolVersion?: '0.1' | '0.2';
}

export interface SyncSessionVerifyInput {
  readonly credential: VerifiedExtensionCredential;
  readonly sessionId: string;
  readonly collectionId: string;
  readonly replicaId: string;
}

export interface SyncSessionReplicaLeaseEnvelope {
  readonly leaseId: string;
  readonly generation: string;
  readonly state: 'active';
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly acknowledgedCursor: string | null;
}

export interface SyncSessionIssueEnvelope {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly serverTime: string;
  readonly acceptedProtocolVersion: '0.1' | '0.2';
  readonly scope: 'collection';
  readonly maxBatchOperations: number;
  readonly tombstoneRetentionSeconds: number;
  readonly replicaLease: SyncSessionReplicaLeaseEnvelope;
  readonly collectionRevision: string;
  readonly collectionCursor: string;
  readonly snapshotRequired: boolean;
  readonly conversionPolicy: {
    readonly alias: 'duplicate' | 'skip';
    readonly separator: 'native' | 'preserve_remote';
    readonly unknownExtensions: 'preserve_remote';
  };
  readonly endpointCapabilities: readonly string[];
  readonly batchBindingSecret: string;
  readonly endpointCapability: string;
}

export interface SyncSessionIssueResult {
  readonly state: 'issued' | 'replayed';
  readonly session: VerifiedSyncSession;
  readonly envelope: SyncSessionIssueEnvelope;
}

/**
 * Byte-stable response identity recovered from the idempotency receipt on
 * replay. Every replay of the same receipt returns these fields unchanged so
 * the response stays indistinguishable from the original issue; the remaining
 * envelope fields are recomputed from the current authority facts.
 */
export interface SyncSessionReplayIdentity {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly serverTime: string;
  readonly acceptedProtocolVersion: '0.1' | '0.2';
  readonly scope: 'collection';
  readonly maxBatchOperations: number;
  readonly tombstoneRetentionSeconds: number;
  readonly batchBindingSecret: string;
  readonly endpointCapability: string;
}

/**
 * Dynamic authority facts recomputed under the transaction lock on replay.
 * These fields must reflect the current state and never the first receipt, so
 * capability hints and recovery status can never contradict the freshly minted
 * Session.
 */
export interface SyncSessionReplayAuthorityFacts {
  readonly replicaLease: SyncSessionReplicaLeaseEnvelope;
  readonly collectionRevision: string;
  readonly collectionCursor: string;
  readonly snapshotRequired: boolean;
  readonly conversionPolicy: SyncSessionIssueEnvelope['conversionPolicy'];
  readonly endpointCapabilities: readonly string[];
}

/**
 * Rebuilds a Session issue envelope from the byte-stable replay identity and
 * the current authority facts. Dynamic authority hints are taken exclusively
 * from `facts`, so a stale receipt can never leak revoked scopes or an outdated
 * recovery status.
 */
export function rebuildSyncSessionIssueEnvelope(
  identity: SyncSessionReplayIdentity,
  facts: SyncSessionReplayAuthorityFacts,
): SyncSessionIssueEnvelope {
  return Object.freeze({
    sessionId: identity.sessionId,
    expiresAt: identity.expiresAt,
    serverTime: identity.serverTime,
    acceptedProtocolVersion: identity.acceptedProtocolVersion,
    scope: identity.scope,
    maxBatchOperations: identity.maxBatchOperations,
    tombstoneRetentionSeconds: identity.tombstoneRetentionSeconds,
    replicaLease: Object.freeze({ ...facts.replicaLease }),
    collectionRevision: facts.collectionRevision,
    collectionCursor: facts.collectionCursor,
    snapshotRequired: facts.snapshotRequired,
    conversionPolicy: Object.freeze({ ...facts.conversionPolicy }),
    endpointCapabilities: Object.freeze([...facts.endpointCapabilities]),
    batchBindingSecret: identity.batchBindingSecret,
    endpointCapability: identity.endpointCapability,
  });
}

export interface SyncSessionAuthorityFacts {
  readonly kind: 'bootstrap' | 'active' | 'recovery';
  readonly wireLeaseState: 'active';
  readonly snapshotRequired: boolean;
  readonly scopeCeiling: 'requested' | 'bootstrap_only';
}

export function classifySyncSessionAuthorityFacts(input: {
  readonly replicaState: 'active' | 'expired' | 'recovery_required' | 'retired';
  readonly checkpointCursor: string | null;
}): SyncSessionAuthorityFacts {
  if (input.replicaState === 'recovery_required') return Object.freeze({
    kind: 'recovery', wireLeaseState: 'active', snapshotRequired: true, scopeCeiling: 'bootstrap_only',
  });
  if (input.replicaState === 'active') return Object.freeze(input.checkpointCursor === null
    ? { kind: 'bootstrap', wireLeaseState: 'active', snapshotRequired: true, scopeCeiling: 'requested' }
    : { kind: 'active', wireLeaseState: 'active', snapshotRequired: false, scopeCeiling: 'requested' });
  throw new TypeError(`Session authority cannot be issued for Replica state ${input.replicaState}`);
}

const ISSUE_KEYS = new Set([
  'credential', 'idempotencyKey', 'requestFingerprint', 'collectionId', 'replicaId',
  'expectedLeaseGeneration', 'expectedLifecycleRevision', 'binding', 'requestedScopes', 'origin',
  'protocolVersion',
]);
const VERIFY_KEYS = new Set(['credential', 'sessionId', 'collectionId', 'replicaId']);
const CREDENTIAL_KEYS = new Set([
  'kind', 'issuer', 'subject', 'audience', 'clientId', 'scopes', 'credentialId',
  'credentialDigest', 'credentialIssuedAt', 'credentialExpiresAt', 'verifiedAt', 'evidenceExpiresAt',
]);
const SESSION_SCOPES = new Set(['sync:bootstrap', 'sync:pull', 'sync:push']);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${label} contains an unknown field`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is incomplete`);
  }
}

function nonEmpty(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalCounter(value: unknown, label: string, allowZero: boolean): string {
  const text = nonEmpty(value, label, 32);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || (!allowZero && text === '0')) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${label} is unsafe`);
  return text;
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} is invalid`);
  return value;
}

export function validateVerifiedExtensionCredential(value: unknown): VerifiedExtensionCredential {
  if (!isVerifiedExtensionCredential(value)) {
    throw new TypeError('P3-01 VerifiedExtensionCredential runtime evidence is required');
  }
  const candidate = plainRecord(value, 'Verified extension credential');
  exactKeys(candidate, CREDENTIAL_KEYS, 'Verified extension credential');
  if (candidate.kind !== 'verified_extension_credential') {
    throw new TypeError('P3-01 VerifiedExtensionCredential is required');
  }
  const audiences = Array.isArray(candidate.audience)
    ? candidate.audience.map((item) => nonEmpty(item, 'Credential audience', 2048))
    : nonEmpty(candidate.audience, 'Credential audience', 2048);
  if (!Array.isArray(candidate.scopes)
      || candidate.scopes.some((scope) => typeof scope !== 'string' || scope.length < 1)) {
    throw new TypeError('Credential scopes are invalid');
  }
  nonEmpty(candidate.issuer, 'Credential issuer', 2048);
  nonEmpty(candidate.subject, 'Credential subject');
  nonEmpty(candidate.clientId, 'Credential client ID');
  nonEmpty(candidate.credentialId, 'Credential ID');
  nonEmpty(candidate.credentialDigest, 'Credential digest');
  validDate(candidate.credentialIssuedAt, 'Credential issued time');
  validDate(candidate.credentialExpiresAt, 'Credential expiry');
  validDate(candidate.verifiedAt, 'Credential verification time');
  validDate(candidate.evidenceExpiresAt, 'Credential evidence expiry');
  void audiences;
  return value;
}

export function validateSyncSessionIssueInput(value: unknown): Readonly<SyncSessionIssueInput> {
  const supplied = plainRecord(value, 'Sync Session issue input');
  const candidate = Object.hasOwn(supplied, 'protocolVersion')
    ? supplied : { ...supplied, protocolVersion: '0.1' };
  exactKeys(candidate, ISSUE_KEYS, 'Sync Session issue input');
  const verified = validateVerifiedExtensionCredential(candidate.credential);
  const binding = validateReplicaBindingFacts(candidate.binding);
  if (!Array.isArray(candidate.requestedScopes) || candidate.requestedScopes.length < 1) {
    throw new TypeError('Requested Session scopes are invalid');
  }
  const scopes = candidate.requestedScopes.map((scope) => {
    if (typeof scope !== 'string' || !SESSION_SCOPES.has(scope)) {
      throw new TypeError('Requested Session scope is invalid');
    }
    return scope as 'sync:bootstrap' | 'sync:pull' | 'sync:push';
  }).sort();
  if (new Set(scopes).size !== scopes.length) throw new TypeError('Requested Session scopes contain duplicates');
  const origin = nonEmpty(candidate.origin, 'Extension origin', 2048);
  if (!origin.startsWith('chrome-extension://')) throw new TypeError('Extension origin is invalid');
  if (candidate.protocolVersion !== '0.1' && candidate.protocolVersion !== '0.2') {
    throw new TypeError('Sync Session protocol version is invalid');
  }
  return Object.freeze({
    credential: verified,
    idempotencyKey: nonEmpty(candidate.idempotencyKey, 'Idempotency key'),
    requestFingerprint: nonEmpty(candidate.requestFingerprint, 'Request fingerprint'),
    collectionId: validateProtocolSafeReplicaId(candidate.collectionId, 'Collection ID'),
    replicaId: validateProtocolSafeReplicaId(candidate.replicaId, 'Replica ID'),
    expectedLeaseGeneration: canonicalCounter(candidate.expectedLeaseGeneration, 'Lease generation', false),
    expectedLifecycleRevision: canonicalCounter(candidate.expectedLifecycleRevision, 'Lifecycle revision', true),
    binding,
    requestedScopes: Object.freeze(scopes),
    origin,
    protocolVersion: candidate.protocolVersion,
  });
}

export function validateSyncSessionVerifyInput(value: unknown): Readonly<SyncSessionVerifyInput> {
  const candidate = plainRecord(value, 'Sync Session verify input');
  exactKeys(candidate, VERIFY_KEYS, 'Sync Session verify input');
  return Object.freeze({
    credential: validateVerifiedExtensionCredential(candidate.credential),
    sessionId: validateProtocolSafeReplicaId(candidate.sessionId, 'Session ID'),
    collectionId: validateProtocolSafeReplicaId(candidate.collectionId, 'Collection ID'),
    replicaId: validateProtocolSafeReplicaId(candidate.replicaId, 'Replica ID'),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Sync Session fingerprint contains unsupported data');
  return encoded;
}

export function canonicalSyncSessionFingerprint(value: unknown): string {
  const input = validateSyncSessionIssueInput(value);
  const canonical = canonicalJson({
    contract: 'known.sync-session.issue.v1', requestFingerprint: input.requestFingerprint,
    issuer: input.credential.issuer, credentialId: input.credential.credentialId,
    clientId: input.credential.clientId, collectionId: input.collectionId,
    replicaId: input.replicaId, expectedLeaseGeneration: input.expectedLeaseGeneration,
    expectedLifecycleRevision: input.expectedLifecycleRevision, binding: input.binding,
    requestedScopes: input.requestedScopes, origin: input.origin,
    protocolVersion: input.protocolVersion,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

export function redactSyncSessionIssueError(value: unknown): Readonly<{ code: SyncSessionIssueErrorCode }> {
  const code = typeof value === 'object' && value !== null
    ? (value as { readonly code?: unknown }).code : undefined;
  const allowed = new Set<SyncSessionIssueErrorCode>([
    'credential_invalid', 'not_found', 'stale_replica', 'replica_expired',
    'replica_recovery_required', 'replica_retired', 'idempotency_key_reuse',
    'session_expired', 'session_revoked', 'integrity_failure',
  ]);
  return Object.freeze({ code: allowed.has(code as SyncSessionIssueErrorCode)
    ? code as SyncSessionIssueErrorCode : 'integrity_failure' });
}

export function asColpScopes(
  scopes: SyncSessionIssueInput['requestedScopes'],
): CreateSyncSessionInput['authorizationScopes'] {
  return scopes;
}
