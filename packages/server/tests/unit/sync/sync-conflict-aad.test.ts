import assert from 'node:assert/strict';
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'vitest';
import {
  SYNC_CONFLICT_AAD_FIELDS, buildSyncConflictAad, type SyncConflictAadSource,
} from '../../../src/infrastructure/sync/sync-conflict-aad.js';
import { encryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { decryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { stableJson } from '../../../src/infrastructure/sync/sync-conflict-json.js';

const invalid = (): never => { throw new Error('invalid conflict json'); };
const key = Buffer.alloc(32, 7);
const keyring = { active: { key, keyVersion: 7 }, retained: [] } as const;

function source(overrides: Partial<SyncConflictAadSource> = {}): SyncConflictAadSource {
  return {
    collectionId: 'collection', replicaId: 'replica', leaseGeneration: '1', sessionId: 'session',
    operationId: 'operation', targetId: 'target', conflictId: 'conflict', commitOrdinal: '9',
    conflictType: 'concurrent_field_update', conflictingFields: stableJson(['/title'], invalid),
    nodeKind: 'bookmark', baseRevision: 'base', currentRevision: 'current', keyVersion: '7', ...overrides,
  };
}

function encryptHistorical(plaintext: string, aad: SyncConflictAadSource) {
  const hkdfKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0),
    Buffer.from('known.sync-conflict.private.v1', 'utf8'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', hkdfKey, iv);
  cipher.setAAD(Buffer.from(stableJson(buildSyncConflictAad(aad), invalid), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(),
    digest: createHmac('sha256', hkdfKey).update(plaintext, 'utf8').digest('base64url') };
}

function row(encrypted: ReturnType<typeof encryptHistorical>, aad: SyncConflictAadSource, version = 7) {
  return {
    collection_id: aad.collectionId, replica_id: aad.replicaId, session_id: aad.sessionId,
    operation_id: aad.operationId, target_id: aad.targetId, conflict_id: aad.conflictId,
    commit_ordinal: BigInt(aad.commitOrdinal), conflict_type: aad.conflictType,
    conflicting_fields: JSON.parse(aad.conflictingFields) as unknown,
    base_revision: aad.baseRevision, current_revision: aad.currentRevision,
    private_payload_key_version: version, private_payload_iv: encrypted.iv,
    private_payload_auth_tag: encrypted.authTag, private_payload_ciphertext: encrypted.ciphertext,
    private_payload_digest: encrypted.digest,
  };
}

test('one builder owns the fourteen-field AAD shape', () => {
  const aad = buildSyncConflictAad(source());
  assert.deepEqual(Object.keys(aad), [...SYNC_CONFLICT_AAD_FIELDS]);
  assert.equal(stableJson(aad, invalid),
    '{"baseRevision":"base","collectionId":"collection","commitOrdinal":"9","conflictId":"conflict","conflictType":"concurrent_field_update","conflictingFields":"[\\"/title\\"]",'
    + '"currentRevision":"current","keyVersion":"7",'
    + '"leaseGeneration":"1","nodeKind":"bookmark","operationId":"operation","replicaId":"replica",'
    + '"sessionId":"session","targetId":"target"}');
  assert.throws(() => buildSyncConflictAad({ ...source(), extra: 'x' } as never), /unexpected field set/u);
  assert.throws(() => buildSyncConflictAad({ ...source(), targetId: 1 } as never), /must be a string/u);
});

test('historical ciphertext decrypts with the extracted builder', () => {
  const plaintext = stableJson({ base: { title: 'B' }, current: { title: 'C' },
    incoming: { title: 'I' }, nodeKind: 'bookmark' }, invalid);
  const aad = source();
  const encrypted = encryptHistorical(plaintext, aad);
  const decoded = decryptPrivatePayload(row(encrypted, aad) as never, keyring, 'bookmark', 1n, invalid);
  assert.deepEqual(decoded, { base: { title: 'B' }, current: { title: 'C' },
    incoming: { title: 'I' }, nodeKind: 'bookmark' });
});

test('encryption and decryption agree on the builder bytes', () => {
  const plaintext = stableJson({ base: {}, current: {}, incoming: {}, nodeKind: 'bookmark' }, invalid);
  const aad = source();
  const encrypted = encryptPrivatePayload(plaintext, keyring.active, aad);
  const decoded = decryptPrivatePayload(row(encrypted, aad) as never, keyring, 'bookmark', 1n, invalid);
  assert.deepEqual(decoded.current, {});
});

test('a different AAD is rejected by GCM even with the same key and ciphertext', () => {
  const encrypted = encryptHistorical('{}', source({ targetId: 'other-target' }));
  assert.throws(() => decryptPrivatePayload(row(encrypted, source()) as never, keyring, 'bookmark', 1n, invalid),
    /invalid conflict json/u);
});
