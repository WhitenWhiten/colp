import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { VerifiedSyncSession } from '@know-n/colp/sync';
import {
  classifySyncSessionAuthorityFacts,
  SyncSessionIssueError,
  type SyncSessionIssueEnvelope,
  type SyncSessionReplayAuthorityFacts,
  type SyncSessionReplayIdentity,
} from '../../../modules/sync/index.js';
import type { SyncSessionIdempotencyReceiptTable, SyncSessionTable } from '../../database/runtime.js';
import {
  endpointCapabilitiesForScopes,
  formatInstant,
  sha256,
} from './sync-session-admission-postgres.js';
import type {
  Authority,
  EncryptedEnvelope,
  ValidatedOptions,
  SyncAuthorizationScope,
} from './sync-session-types-postgres.js';

export function receiptAad(input: {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly sessionId: string;
  readonly keyVersion: number;
}): Buffer {
  return Buffer.from([
    'known.sync-session.receipt.v1', input.principalId, 'collection', input.idempotencyKey,
    input.requestFingerprint, input.collectionId, input.replicaId, input.sessionId,
    String(input.keyVersion),
  ].join('\0'), 'utf8');
}

export function encryptEnvelope(
  envelope: SyncSessionIssueEnvelope,
  key: Buffer,
  aad: Buffer,
): EncryptedEnvelope {
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({ ciphertext, iv, authTag: cipher.getAuthTag(), digest: sha256(plaintext) });
}

export function decryptEnvelope(
  row: Selectable<SyncSessionIdempotencyReceiptTable>,
  key: Buffer,
  expectedKeyVersion: number,
): SyncSessionIssueEnvelope {
  try {
    if (row.result_key_version !== expectedKeyVersion) throw new Error('key version mismatch');
    const decipher = createDecipheriv('aes-256-gcm', key, row.result_iv);
    decipher.setAAD(receiptAad({
      principalId: row.principal_id,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      collectionId: row.collection_id,
      replicaId: row.replica_id,
      sessionId: row.session_id,
      keyVersion: row.result_key_version,
    }));
    decipher.setAuthTag(row.result_auth_tag);
    const plaintext = Buffer.concat([decipher.update(row.result_ciphertext), decipher.final()]);
    if (sha256(plaintext) !== row.result_digest) throw new Error('digest mismatch');
    return Object.freeze(JSON.parse(plaintext.toString('utf8')) as SyncSessionIssueEnvelope);
  } catch {
    throw new SyncSessionIssueError('integrity_failure');
  }
}

/**
 * Extracts the byte-stable replay identity from the decrypted receipt envelope
 * and binds it to the current Session row, so a corrupted or mismatched receipt
 * can never serve another Session's secrets or identity.
 */
export function replayIdentityFromEnvelope(
  envelope: SyncSessionIssueEnvelope,
  receipt: Selectable<SyncSessionIdempotencyReceiptTable>,
  verified: VerifiedSyncSession,
  sessionRow: Selectable<SyncSessionTable>,
): SyncSessionReplayIdentity {
  if (envelope.sessionId !== receipt.session_id
      || envelope.sessionId !== verified.sessionId
      || envelope.expiresAt !== verified.expiresAt
      || envelope.acceptedProtocolVersion !== verified.protocolVersion
      || envelope.scope !== 'collection'
      || sha256(envelope.batchBindingSecret) !== sessionRow.secret_digest
      || sha256(envelope.endpointCapability) !== sessionRow.capability_digest) {
    throw new SyncSessionIssueError('integrity_failure');
  }
  return Object.freeze({
    sessionId: envelope.sessionId,
    expiresAt: envelope.expiresAt,
    serverTime: envelope.serverTime,
    acceptedProtocolVersion: envelope.acceptedProtocolVersion,
    scope: envelope.scope,
    maxBatchOperations: envelope.maxBatchOperations,
    tombstoneRetentionSeconds: envelope.tombstoneRetentionSeconds,
    batchBindingSecret: envelope.batchBindingSecret,
    endpointCapability: envelope.endpointCapability,
  });
}

/**
 * Recomputes the dynamic authority hints for a replay from the rows locked by
 * this transaction, using only the scopes the current authority still grants.
 */
export function replayAuthorityFacts(
  authority: Authority,
  options: ValidatedOptions,
  sessionId: string,
  currentScopes: readonly SyncAuthorizationScope[],
): SyncSessionReplayAuthorityFacts {
  const facts = classifySyncSessionAuthorityFacts({
    replicaState: authority.replica.status,
    checkpointCursor: authority.replica.checkpoint_cursor,
  });
  return Object.freeze({
    replicaLease: Object.freeze({
      leaseId: authority.replica.lease_id,
      generation: BigInt(authority.replica.lease_generation).toString(),
      state: facts.wireLeaseState,
      lastSeenAt: formatInstant(authority.replica.last_seen_at),
      expiresAt: formatInstant(authority.replica.lease_expires_at),
      acknowledgedCursor: authority.replica.checkpoint_cursor,
    }),
    collectionRevision: authority.contentRevision,
    collectionCursor: authority.replica.checkpoint_cursor ?? `bootstrap-${sessionId}`,
    snapshotRequired: facts.snapshotRequired,
    conversionPolicy: Object.freeze({
      alias: authority.replica.capabilities_json.alias ? 'duplicate' : 'skip',
      separator: authority.replica.capabilities_json.separator ? 'native' : 'preserve_remote',
      unknownExtensions: 'preserve_remote',
    }),
    endpointCapabilities: endpointCapabilitiesForScopes(options.endpointCapabilities, currentScopes),
  });
}
