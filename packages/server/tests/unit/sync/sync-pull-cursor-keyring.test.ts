import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createSyncPullCursorKeyring,
  createSyncPullCursorLineageKeyring,
  syncPullStableIdHash,
  type SyncPullCursorContext,
  type SyncPullCursorLineageFacts,
} from '../../../src/modules/sync/application/sync-pull.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';

const oldSecret = Buffer.alloc(32, 19).toString('base64');
const currentSecret = Buffer.alloc(32, 41).toString('base64');
const tuple = Object.freeze({ commitOrdinal: '42', streamKind: 'conflict' as const, stableId: 'conflict-2' });
const context: SyncPullCursorContext = Object.freeze({
  replicaId: 'replica-1', collectionId: 'collection-1', leaseGeneration: '7',
  sessionId: 'session-1', principalId: 'account-1', protocolVersion: '0.1',
  policyRevision: 'policy-4', limit: 2,
  purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
});

test('P3-20 Sync cursor signs the complete exclusive tuple and survives restart and rotation', () => {
  let now = Date.parse('2026-07-26T06:00:00Z');
  const old = createSyncPullCursorKeyring({
    active: { id: 'old', secret: oldSecret }, retained: [], ttlMs: 60_000, now: () => now,
  });
  const cursor = old.sign({ ...context, tuple });
  old.destroy();

  const rotated = createSyncPullCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [{ id: 'old', secret: oldSecret }], ttlMs: 60_000, now: () => now,
  });
  assert.deepEqual(rotated.verify(cursor, context), { valid: true, anchor: {
    commitOrdinal: tuple.commitOrdinal, streamKind: tuple.streamKind,
    stableIdHash: syncPullStableIdHash(tuple.stableId),
  }, expiresAt: now + 60_000 });
  const current = rotated.sign({ ...context, tuple: { ...tuple, stableId: 'conflict-3' } });
  rotated.destroy();

  const restarted = createSyncPullCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [{ id: 'old', secret: oldSecret }], ttlMs: 60_000, now: () => now,
  });
  assert.equal(restarted.verify(cursor, context).valid, true);
  assert.equal(restarted.verify(current, context).valid, true);
  restarted.destroy();
});

test('P3-20 Sync cursor rejects tamper, expiry and every replayable scope change', () => {
  let now = 10_000;
  const keys = createSyncPullCursorKeyring({
    active: { id: 'current', secret: currentSecret }, retained: [], ttlMs: 500, now: () => now,
  });
  const cursor = keys.sign({ ...context, tuple });
  const inherited = keys.sign({ ...context, tuple: { ...tuple, stableId: 'operation-2' } }, now + 500);
  assert.equal(keys.sign({ ...context, tuple: { ...tuple, stableId: 'operation-2' } }, now + 500), inherited);
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(keys.verify(tampered, context).valid, false);
  for (const changed of [
    { ...context, replicaId: 'replica-2' },
    { ...context, collectionId: 'collection-2' },
    { ...context, leaseGeneration: '8' },
    { ...context, sessionId: 'session-2' },
    { ...context, principalId: 'account-2' },
    { ...context, protocolVersion: '0.2' },
    { ...context, policyRevision: 'policy-5' },
    { ...context, limit: 3 },
    { ...context, purgeBoundary: { ...context.purgeBoundary, commitOrdinal: '1' } },
  ]) assert.equal(keys.verify(cursor, changed).valid, false);
  now += 501;
  assert.deepEqual(keys.verify(cursor, context), { valid: false, code: 'sync_cursor_expired' });
  keys.destroy();
});

test('P3-20 Sync cursor has an isolated purpose and never exposes deployment secrets', () => {
  const keys = createSyncPullCursorKeyring({
    active: { id: 'current', secret: currentSecret }, retained: [], ttlMs: 500, now: () => 1,
  });
  const cursor = keys.sign({ ...context, tuple });
  assert.match(cursor, /^spc2\./u);
  assert.ok(cursor.length <= 128);
  assert.equal(cursor.includes(currentSecret), false);
  assert.equal(JSON.stringify(keys).includes(currentSecret), false);
  const publication = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret }, retained: [],
  });
  assert.equal(publication.snapshot.verify(cursor, {
    collectionId: 'collection-1', resourceId: 'https://colp.example/colp/v0.1/collections/collection-1/snapshot',
    revision: 'r1', comparatorVersion: 'parent-position-id-v1', principal: 'anonymous', pageSize: 2,
  }).valid, false);
  const publicationCursor = publication.snapshot.sign({
    collectionId: 'collection-1', resourceId: 'https://colp.example/colp/v0.1/collections/collection-1/snapshot',
    revision: 'r1', comparatorVersion: 'parent-position-id-v1', principal: 'anonymous', pageSize: 2,
    nextPosition: 'next',
  });
  assert.equal(keys.verify(publicationCursor, context).valid, false);
  const editor = createProductEditorCursorSigner({
    current: { id: 'current', key: currentSecret }, issuanceFormat: 'keyed',
  });
  const editorCursor = editor.sign({
    v: 1, purpose: 'product-editor-cursor', principalId: 'account-1', collectionId: 'collection-1',
    limit: 2, comparatorVersion: 'v1',
    after: { parentKey: '', positionKey: '', nodeId: 'node-1' },
    contentRevision: 'content-1', policyRevision: 'policy-4', snapshotId: 'snapshot-1',
    issuedAt: '1970-01-01T00:00:00.000Z', expiresAt: '1970-01-01T00:10:00.000Z',
  });
  assert.equal(keys.verify(editorCursor, context).valid, false);
  assert.throws(() => editor.verify(cursor, new Date(1)));
  publication.destroy();
  keys.destroy();
  assert.throws(() => keys.sign({ ...context, tuple }), /destroyed/u);
  assert.equal(keys.verify(cursor, context).valid, false);

  for (const config of [
    { active: { id: 'weak', secret: Buffer.alloc(8).toString('base64') }, retained: [] },
    { active: { id: 'same', secret: currentSecret }, retained: [{ id: 'same', secret: oldSecret }] },
    { active: { id: 'current', secret: currentSecret }, retained: [{ id: 'old', secret: currentSecret }] },
  ]) {
    let message = '';
    try { createSyncPullCursorKeyring({ ...config, ttlMs: 500 }); } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(message.length > 0);
    assert.equal(message.includes(currentSecret), false);
    assert.equal(message.includes(oldSecret), false);
  }
});

const oldLineageSecret = Buffer.alloc(32, 29).toString('base64');
const currentLineageSecret = Buffer.alloc(32, 31).toString('base64');

function lineageFacts(overrides: Partial<SyncPullCursorLineageFacts> = {}): SyncPullCursorLineageFacts {
  return Object.freeze({
    cursorDigest: 'a'.repeat(64),
    sessionId: 'session-1', accountId: 'account-1', collectionId: 'collection-1',
    replicaId: 'replica-1', leaseGeneration: '7', policyRevision: 'policy-4',
    protocolVersion: '0.1', pageLimit: 2,
    tuple: Object.freeze({ commitOrdinal: '42', streamKind: 'conflict' as const, stableId: 'conflict-2' }),
    cursorExpiresAt: 10_000,
    ...overrides,
  });
}

test('P3-20 Sync cursor lineage receipt binds minimal facts and survives independent key rotation', () => {
  const old = createSyncPullCursorLineageKeyring({
    active: { id: 'lineage-old', secret: oldLineageSecret }, retained: [],
  });
  const facts = lineageFacts();
  const receipt = old.sign(facts);
  assert.match(receipt, /^spl1\.lineage-old\./u);
  old.destroy();

  const rotated = createSyncPullCursorLineageKeyring({
    active: { id: 'lineage-current', secret: currentLineageSecret },
    retained: [{ id: 'lineage-old', secret: oldLineageSecret }],
  });
  assert.deepEqual(rotated.verify(receipt, facts), { valid: true, keyId: 'lineage-old' });
  const current = rotated.sign(lineageFacts({ cursorExpiresAt: 20_000 }));
  assert.deepEqual(rotated.verify(current, lineageFacts({ cursorExpiresAt: 20_000 })),
    { valid: true, keyId: 'lineage-current' });
  rotated.destroy();

  const rotatedOut = createSyncPullCursorLineageKeyring({
    active: { id: 'lineage-current', secret: currentLineageSecret }, retained: [],
  });
  assert.equal(rotatedOut.verify(receipt, facts).valid, false);
  assert.equal(rotatedOut.verify(current, lineageFacts({ cursorExpiresAt: 20_000 })).valid, true);
  rotatedOut.destroy();
  assert.throws(() => old.sign(facts), /destroyed/u);
});

test('P3-20 Sync cursor lineage receipt rejects tamper and never exposes cursors or secrets', () => {
  const keys = createSyncPullCursorLineageKeyring({
    active: { id: 'lineage-current', secret: currentLineageSecret }, retained: [],
  });
  const facts = lineageFacts();
  const receipt = keys.sign(facts);
  const tampered = `${receipt.slice(0, -1)}${receipt.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(keys.verify(tampered, facts).valid, false);
  for (const changed of [
    { cursorDigest: 'b'.repeat(64) },
    { sessionId: 'session-2' },
    { accountId: 'account-2' },
    { collectionId: 'collection-2' },
    { replicaId: 'replica-2' },
    { leaseGeneration: '8' },
    { policyRevision: 'policy-5' },
    { protocolVersion: '0.2' },
    { pageLimit: 3 },
    { tuple: { commitOrdinal: '43', streamKind: 'conflict', stableId: 'conflict-2' } },
    { cursorExpiresAt: 11_000 },
  ]) assert.equal(keys.verify(receipt, lineageFacts(changed)).valid, false);
  assert.equal(keys.verify(receipt, { ...facts, tuple: { ...facts.tuple, stableId: 'conflict-3' } }).valid, false);

  // The receipt is a digest-only authenticator: it never carries the cursor payload
  // or the signing secret, and the keyring JSON never serializes the material.
  assert.equal(receipt.includes(facts.cursorDigest), false);
  assert.equal(JSON.stringify(keys).includes(currentLineageSecret), false);
  assert.equal(JSON.stringify(keys).includes(facts.cursorDigest), false);

  for (const config of [
    { active: { id: 'weak-lineage', secret: Buffer.alloc(8).toString('base64') }, retained: [] },
    { active: { id: 'lineage-same', secret: currentLineageSecret },
      retained: [{ id: 'lineage-same', secret: oldLineageSecret }] },
    { active: { id: 'lineage-current', secret: currentLineageSecret },
      retained: [{ id: 'lineage-old', secret: currentLineageSecret }] },
    { active: { id: 'recovery-capability-key', secret: currentLineageSecret }, retained: [] },
    { active: { id: 'lineage-publication', secret: currentLineageSecret }, retained: [] },
  ]) {
    let message = '';
    try { createSyncPullCursorLineageKeyring(config); } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(message.length > 0);
    assert.equal(message.includes(currentLineageSecret), false);
    assert.equal(message.includes(oldLineageSecret), false);
  }
  keys.destroy();
});
