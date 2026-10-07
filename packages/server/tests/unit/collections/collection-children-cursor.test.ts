/**
 * FO-05 `listCollectionChildren` cursor codec unit tests (pure, no I/O).
 * Covers HMAC sign/verify round-trip, tamper/mismatch => 400 invalid_cursor,
 * valid-but-expired => 409 snapshot_expired, closed-payload validation, key
 * stability (same key across signer instances) and encodedLength agreement.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  PRODUCT_COLLECTION_CHILDREN_CURSOR_KEY_ID,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
  CollectionChildrenCursorError,
  CollectionChildrenCursorExpiredError,
  createCollectionChildrenCursorSigner,
  viewerScope,
  type CollectionChildrenCursorPayload,
  type CollectionChildrenViewer,
} from '../../../src/modules/collections/index.js';

const KEY = Buffer.alloc(32, 7).toString('base64url');

function payload(overrides: Partial<CollectionChildrenCursorPayload> = {}): CollectionChildrenCursorPayload {
  const issued = new Date('2026-09-14T00:00:00.000Z');
  const expires = new Date(issued.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS);
  return {
    v: PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
    purpose: PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
    viewer: viewerScope({ kind: 'anonymous' } as CollectionChildrenViewer),
    collectionId: 'coll-fo05-0001',
    parentId: '',
    sort: 'created_asc',
    limit: 25,
    contentRevision: 'coll-content-9',
    after: { nodeId: 'node-fo05-0003', positionKey: 'B2', createdAt: '2026-09-14T00:00:01.000Z' },
    issuedAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
    ...overrides,
  };
}

const signer = () => createCollectionChildrenCursorSigner(KEY);

describe('CollectionChildrenCursorSigner', () => {
  test('sign/verify round-trip yields the exact payload', () => {
    const s = signer();
    const p = payload();
    const token = s.sign(p);
    assert.ok(token.length >= 1 && token.length <= 2048);
    assert.match(token, /^[A-Za-z0-9_-]+$/u);
    assert.deepEqual(s.verify(token, new Date('2026-09-14T00:00:05.000Z')), p);
    // Key stability: an independent signer with the same key verifies the same token.
    assert.deepEqual(signer().verify(token, new Date('2026-09-14T00:00:05.000Z')), p);
  });

  test('encodedLength matches the actual token length', () => {
    const s = signer();
    const p = payload();
    const token = s.sign(p);
    assert.equal(s.encodedLength(p), token.length);
    assert.equal(Buffer.byteLength(token, 'utf8'), token.length);
  });

  test('a different key invalidates the token (400 invalid_cursor)', () => {
    const s = signer();
    const other = createCollectionChildrenCursorSigner(Buffer.alloc(32, 19).toString('base64url'));
    const token = s.sign(payload());
    assert.throws(() => other.verify(token, new Date('2026-09-14T00:00:05.000Z')),
      CollectionChildrenCursorError);
  });

  test('tampered signature / body / key id / format are 400 invalid_cursor', () => {
    const s = signer();
    const token = s.sign(payload());
    const now = new Date('2026-09-14T00:00:05.000Z');
    const body = token.slice(0, -43);
    const signature = token.slice(-43);
    const flipped = signature.endsWith('A') ? `${signature.slice(0, -1)}B` : `${signature.slice(0, -1)}A`;
    assert.throws(() => s.verify(`${body}${flipped}`, now), CollectionChildrenCursorError);
    const bodyFlip = body.endsWith('A') ? `${body.slice(0, -1)}B` : `${body.slice(0, -1)}A`;
    assert.throws(() => s.verify(`${bodyFlip}${signature}`, now), CollectionChildrenCursorError);
    for (const bad of ['', 'a.b', 'a.b.c.d', 'plain', '...', 'x'.repeat(2049)]) {
      assert.throws(() => s.verify(bad, now), CollectionChildrenCursorError, `token ${JSON.stringify(bad).slice(0, 30)}`);
    }
  });

  test('a validly-signed token with an elapsed 900s window is 409 snapshot_expired', () => {
    const s = signer();
    const issued = new Date('2026-09-14T00:00:00.000Z');
    const p = payload({
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS).toISOString(),
    });
    const token = s.sign(p);
    // Inside the window: fine.
    assert.deepEqual(s.verify(token, new Date('2026-09-14T00:14:59.000Z')), p);
    // Exactly at expiry => expired (409), not invalid.
    assert.throws(
      () => s.verify(token, new Date('2026-09-14T00:15:00.000Z')),
      CollectionChildrenCursorExpiredError,
    );
    // After expiry => expired, still distinct from tamper.
    assert.throws(
      () => s.verify(token, new Date('2026-09-14T01:00:00.000Z')),
      CollectionChildrenCursorExpiredError,
    );
  });

  test('closed payload validation rejects wrong kinds, missing fields and bad values', () => {
    const s = signer();
    const base = payload();
    const cases: Array<Partial<CollectionChildrenCursorPayload> & { sort?: string; v?: number; limit?: number }> = [
      { v: 2 },
      { purpose: 'other-purpose' },
      { sort: 'by_hand' as never },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { collectionId: '' },
      { parentId: 'x'.repeat(129) },
      { contentRevision: '' },
      { after: { nodeId: '', positionKey: '', createdAt: '2026-09-14T00:00:01.000Z' } },
      { after: { nodeId: 'n', positionKey: '', createdAt: 'not-a-timestamp' } },
      { issuedAt: '2026-09-14T00:00:00.000Z', expiresAt: '' },
      { issuedAt: '2026-09-14T00:00:00.000Z', expiresAt: 'not-a-timestamp' },
    ];
    for (const patch of cases) {
      const candidate = { ...base, ...patch } as unknown as CollectionChildrenCursorPayload;
      assert.throws(() => s.sign(candidate), CollectionChildrenCursorError,
        `sign must reject ${JSON.stringify(patch)}`);
    }
  });

  test('temporal inconsistencies are rejected at verify time as invalid_cursor', () => {
    const s = signer();
    const issued = new Date('2026-09-14T00:00:00.000Z');
    const now = new Date('2026-09-14T00:00:05.000Z');
    // Window longer than 900s.
    const longWindow = s.sign(payload({
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS + 1).toISOString(),
    }));
    assert.throws(() => s.verify(longWindow, now), CollectionChildrenCursorError);
    // Issued after it expires.
    const issuedLater = s.sign(payload({
      issuedAt: new Date(issued.getTime() + 5000).toISOString(),
      expiresAt: new Date(issued.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS).toISOString(),
    }));
    assert.throws(() => s.verify(issuedLater, now), CollectionChildrenCursorError);
  });

  test('the token is dotless (contract charset) and never leaks the secret or key id', () => {
    const s = signer();
    const token = s.sign(payload());
    assert.match(token, /^[A-Za-z0-9_-]+$/u);
    assert.ok(!token.includes('.'));
    assert.ok(!token.includes(KEY), 'token must not contain the key material');
    assert.ok(!token.includes(PRODUCT_COLLECTION_CHILDREN_CURSOR_KEY_ID));
  });
});