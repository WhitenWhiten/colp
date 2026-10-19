/**
 * The one AES-GCM AAD shape for encrypted Conflict private payloads.
 *
 * Encryption, decryption and key rotation used to assemble these fourteen
 * fields independently. A single missing or renamed field authenticates a
 * different byte string, so every historical open Conflict becomes
 * undecryptable. Sources still supply the values; the field set and its
 * presence/type checks live here.
 */
export const SYNC_CONFLICT_AAD_FIELDS = [
  'collectionId', 'replicaId', 'leaseGeneration', 'sessionId', 'operationId', 'targetId',
  'conflictId', 'commitOrdinal', 'conflictType', 'conflictingFields', 'nodeKind',
  'baseRevision', 'currentRevision', 'keyVersion',
] as const;

export type SyncConflictAadField = typeof SYNC_CONFLICT_AAD_FIELDS[number];
export type SyncConflictAadSource = Readonly<Record<SyncConflictAadField, string>>;

export function buildSyncConflictAad(source: SyncConflictAadSource): Readonly<Record<SyncConflictAadField, string>> {
  const keys = Object.keys(source);
  if (keys.length !== SYNC_CONFLICT_AAD_FIELDS.length
      || keys.some((key) => !(SYNC_CONFLICT_AAD_FIELDS as readonly string[]).includes(key))) {
    throw new TypeError('Sync Conflict AAD source has an unexpected field set');
  }
  const aad = {} as Record<SyncConflictAadField, string>;
  for (const field of SYNC_CONFLICT_AAD_FIELDS) {
    const value = source[field];
    if (typeof value !== 'string') throw new TypeError(`Sync Conflict AAD field ${field} must be a string`);
    aad[field] = value;
  }
  return Object.freeze(aad);
}
