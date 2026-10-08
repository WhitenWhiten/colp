import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { SyncConflictTable } from '../database/runtime.js';
import {
  selectSyncConflictPayloadKey,
  type SyncConflictPayloadKeyring,
} from './sync-conflict-postgres.js';
import { isRecord, stableJson } from './sync-conflict-json.js';

/**
 * Conflict private-payload decryption (extracted from
 * `sync-conflict-resolution-postgres.ts` under the shrinking-only source-size
 * baseline).
 *
 * FIX-M-011: the persisted key version selects the key; an unknown version and
 * every authentication/digest/parse failure fail closed through `invalid`.
 */

export interface PrivateConflictPayload {
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
  readonly nodeKind: 'folder' | 'bookmark' | 'separator';
}

export function decryptPrivatePayload(
  conflict: Selectable<SyncConflictTable>,
  keyring: SyncConflictPayloadKeyring,
  nodeKind: 'folder' | 'bookmark' | 'separator',
  leaseGeneration: bigint,
  invalid: () => never,
): PrivateConflictPayload {
  const encryption = selectSyncConflictPayloadKey(keyring, conflict.private_payload_key_version);
  if (!encryption) invalid();
  const key = Buffer.from(hkdfSync('sha256', encryption.key, Buffer.alloc(0),
    Buffer.from('known.sync-conflict.private.v1', 'utf8'), 32));
  const decipher = createDecipheriv('aes-256-gcm', key, conflict.private_payload_iv);
  decipher.setAAD(Buffer.from(stableJson({
    collectionId: conflict.collection_id, replicaId: conflict.replica_id,
    leaseGeneration: leaseGeneration.toString(), sessionId: conflict.session_id, operationId: conflict.operation_id,
    targetId: conflict.target_id, conflictId: conflict.conflict_id,
    commitOrdinal: conflict.commit_ordinal.toString(), conflictType: conflict.conflict_type,
    conflictingFields: stableJson(conflict.conflicting_fields, invalid), nodeKind,
    baseRevision: conflict.base_revision, currentRevision: conflict.current_revision,
    keyVersion: String(conflict.private_payload_key_version),
  }, invalid), 'utf8'));
  decipher.setAuthTag(conflict.private_payload_auth_tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(conflict.private_payload_ciphertext), decipher.final(),
    ]);
  } catch {
    invalid();
  }
  const digest = createHmac('sha256', key).update(plaintext).digest('base64url');
  if (digest !== conflict.private_payload_digest) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(plaintext.toString('utf8')); } catch { invalid(); }
  if (!isRecord(parsed) || !isRecord(parsed.base) || !isRecord(parsed.current)
      || !isRecord(parsed.incoming) || parsed.nodeKind !== nodeKind) invalid();
  return parsed as unknown as PrivateConflictPayload;
}
