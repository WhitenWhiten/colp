import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import {
  decodeProductSyncConflictCursor,
  encodeProductSyncConflictCursor,
} from '../../../src/infrastructure/sync/product-sync-center-postgres.js';
import { stableJson } from '../../../src/infrastructure/sync/product-sync-stable-json.js';

const CURRENT = 'c'.repeat(32);
const PREVIOUS = 'p'.repeat(32);
const ACCOUNT = 'account-1';
const OTHER = 'account-2';
const NOW = Date.parse('2026-10-21T00:00:00.000Z');
const VALUE = { createdAt: '2026-10-21T00:00:00.000Z', id: 'conflict-1', limit: 20 };

test('conflict cursors keep the current signature and accept an unexpired previous key', () => {
  const current = encodeProductSyncConflictCursor(VALUE, ACCOUNT, CURRENT, NOW);
  assert.deepEqual(decodeProductSyncConflictCursor(current, ACCOUNT, CURRENT, [{
    secret: PREVIOUS, retainUntilMs: NOW + 60_000,
  }], NOW), VALUE);
  assert.throws(() => decodeProductSyncConflictCursor(current, ACCOUNT, PREVIOUS, [], NOW), invalidCursor);

  const issuedBeforeRotation = encodeProductSyncConflictCursor(VALUE, ACCOUNT, PREVIOUS, NOW);
  assert.deepEqual(decodeProductSyncConflictCursor(issuedBeforeRotation, ACCOUNT, CURRENT, [{
    secret: PREVIOUS, retainUntilMs: NOW + 60_000,
  }], NOW + 1_000), VALUE);
  assert.throws(() => decodeProductSyncConflictCursor(issuedBeforeRotation, ACCOUNT, CURRENT, [{
    secret: PREVIOUS, retainUntilMs: NOW,
  }], NOW), invalidCursor);
});

test('conflict cursors reject expiry, tampering, unknown keys, other accounts, and other purposes', () => {
  const cursor = encodeProductSyncConflictCursor(VALUE, ACCOUNT, CURRENT, NOW);
  assert.throws(() => decodeProductSyncConflictCursor(cursor, ACCOUNT, CURRENT, [], NOW + 15 * 60_000 + 1), invalidCursor);
  assert.throws(() => decodeProductSyncConflictCursor(`${cursor.slice(0, -1)}x`, ACCOUNT, CURRENT, [], NOW), invalidCursor);
  assert.throws(() => decodeProductSyncConflictCursor(cursor, ACCOUNT, 'u'.repeat(32), [], NOW), invalidCursor);
  assert.throws(() => decodeProductSyncConflictCursor(cursor, OTHER, CURRENT, [], NOW), invalidCursor);
  assert.throws(() => decodeProductSyncConflictCursor('editor-key.editor-body.editor-signature', ACCOUNT, CURRENT, [], NOW), invalidCursor);

  const payload = Buffer.from(stableJson({
    v: 1, p: 'product-editor', exp: NOW + 60_000, ...VALUE,
  }, 'reject'), 'utf8').toString('base64url');
  const signature = createHmac('sha256', CURRENT).update('product-sync-conflicts\0').update(ACCOUNT).update('\0').update(payload).digest('base64url');
  assert.throws(() => decodeProductSyncConflictCursor(`${payload}.${signature}`, ACCOUNT, CURRENT, [], NOW), invalidCursor);
});

function invalidCursor(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'invalid_cursor';
}
