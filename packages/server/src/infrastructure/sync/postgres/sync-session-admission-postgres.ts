import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  SyncSessionIssueError,
  REPLICA_LEASE_BOUNDS,
  validateVerifiedExtensionCredential,
} from '../../../modules/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../modules/identity/index.js';
import type {
  PostgresSyncSessionIssuerOptions,
  SyncAuthorizationScope,
  SyncSessionIdGenerator,
  ValidatedOptions,
} from './sync-session-types-postgres.js';

export const endpointScope = Object.freeze({
  syncSnapshot: 'sync:bootstrap',
  syncPull: 'sync:pull',
  syncAck: 'sync:pull',
  syncPush: 'sync:push',
  syncConflict: 'sync:push',
} satisfies Readonly<Record<string, SyncAuthorizationScope>>);

const defaultIds: SyncSessionIdGenerator = {
  sessionId: () => `session-${randomUUID()}`,
  batchBindingSecret: () => randomBytes(32).toString('base64url'),
  endpointCapability: () => randomBytes(32).toString('base64url'),
};

export function nonEmpty(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string, maximum: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

export function validateOptions(input: PostgresSyncSessionIssuerOptions): ValidatedOptions {
  nonEmpty(input.issuer, 'Sync Session issuer');
  const acceptedIssuers = input.acceptedIssuers ?? [input.issuer];
  if (!Array.isArray(acceptedIssuers) || acceptedIssuers.length < 1 || acceptedIssuers.length > 4
      || acceptedIssuers.some((issuer) => typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 2_048)
      || new Set(acceptedIssuers).size !== acceptedIssuers.length
      || !acceptedIssuers.includes(input.issuer)) {
    throw new TypeError('Sync Session accepted issuers are invalid');
  }
  nonEmpty(input.audience, 'Sync Session audience');
  nonEmpty(input.clientId, 'Sync Session client ID');
  if (!Buffer.isBuffer(input.replayEncryptionKey) || input.replayEncryptionKey.length !== 32) {
    throw new TypeError('Sync Session replay encryption key must contain exactly 32 bytes');
  }
  if (!Number.isSafeInteger(input.replayEncryptionKeyVersion)
      || input.replayEncryptionKeyVersion < 1 || input.replayEncryptionKeyVersion > 2_147_483_647) {
    throw new TypeError('Sync Session replay encryption key version is invalid');
  }
  positiveInteger(input.sessionDurationSeconds, 'Session duration', 86_400);
  positiveInteger(input.replicaLeaseExtensionSeconds, 'Replica lease extension',
    REPLICA_LEASE_BOUNDS.maxSeconds, REPLICA_LEASE_BOUNDS.minSeconds);
  positiveInteger(input.tombstoneRetentionSeconds, 'Tombstone retention', Number.MAX_SAFE_INTEGER);
  if (input.recoveryProofRetentionMs !== undefined) {
    positiveInteger(input.recoveryProofRetentionMs, 'Recovery proof retention', 31_536_000_000);
  }
  if (input.maxBatchOperations !== 1) throw new TypeError('Phase 3 maxBatchOperations must equal one');
  if (!Array.isArray(input.endpointCapabilities) || input.endpointCapabilities.length < 1
      || input.endpointCapabilities.some((item) => typeof item !== 'string' || item.length < 1)
      || input.endpointCapabilities.some((item) => !(item in endpointScope))
      || new Set(input.endpointCapabilities).size !== input.endpointCapabilities.length) {
    throw new TypeError('Sync endpoint capabilities are invalid');
  }
  return Object.freeze({
    ...input,
    acceptedIssuers: Object.freeze([...acceptedIssuers]),
    replayEncryptionKey: Buffer.from(input.replayEncryptionKey),
    endpointCapabilities: Object.freeze([...input.endpointCapabilities]),
    ids: input.ids ?? defaultIds,
    faultInjector: input.faultInjector ?? {},
    resumedLeaseId: input.resumedLeaseId ?? (() => `lease-${randomUUID()}`),
  });
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function audienceIncludes(value: string | readonly string[], expected: string): boolean {
  return typeof value === 'string' ? value === expected : value.includes(expected);
}

export function assertCredentialPreflight(credential: VerifiedExtensionCredential, options: ValidatedOptions): void {
  try {
    validateVerifiedExtensionCredential(credential);
  } catch {
    throw new SyncSessionIssueError('credential_invalid');
  }
  if (credential.kind !== 'verified_extension_credential'
      || !options.acceptedIssuers.includes(credential.issuer)
      || credential.clientId !== options.clientId
      || !audienceIncludes(credential.audience, options.audience)
      || !credential.scopes.includes('known.sync')
      || credential.credentialId.length < 1
      || credential.credentialDigest.length < 16) {
    throw new SyncSessionIssueError('credential_invalid');
  }
}

export function canonicalAudience(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : [...value].sort().join(' ');
}

export function formatInstant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SyncSessionIssueError('integrity_failure');
  }
  return value.toISOString();
}

export function endpointCapabilitiesForScopes(
  configured: readonly string[],
  scopes: readonly SyncAuthorizationScope[],
): readonly string[] {
  const granted = new Set(scopes);
  return Object.freeze(configured.filter((endpoint) =>
    granted.has(endpointScope[endpoint as keyof typeof endpointScope])));
}

export function authorizeRequestedScopes(
  authority: { readonly role: 'owner' | 'editor' | 'viewer'; readonly replica: { readonly capabilities_json: { readonly read?: boolean; readonly write?: boolean } } },
  requested: readonly SyncAuthorizationScope[],
): readonly SyncAuthorizationScope[] {
  const hasRead = authority.replica.capabilities_json.read === true;
  const hasWrite = authority.replica.capabilities_json.write === true;
  if (requested.some((scope) => scope === 'sync:push')
      && (authority.role === 'viewer' || !hasWrite)) {
    throw new SyncSessionIssueError('not_found');
  }
  if (requested.some((scope) => scope === 'sync:bootstrap' || scope === 'sync:pull') && !hasRead) {
    throw new SyncSessionIssueError('not_found');
  }
  return Object.freeze([...requested]);
}

export function currentlyAuthorizedScopes(
  authority: { readonly role: 'owner' | 'editor' | 'viewer'; readonly replica: { readonly capabilities_json: { readonly read?: boolean; readonly write?: boolean } } },
  requested: readonly SyncAuthorizationScope[],
): readonly SyncAuthorizationScope[] {
  return Object.freeze(requested.filter((scope) => {
    if (scope === 'sync:push') {
      return authority.role !== 'viewer' && authority.replica.capabilities_json.write === true;
    }
    return authority.replica.capabilities_json.read === true;
  }));
}
