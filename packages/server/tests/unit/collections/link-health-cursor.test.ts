import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
  PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
  PRODUCT_LINK_HEALTH_SORT,
  createProductLinkHealthCursorSigner,
  LinkHealthCursorError,
} from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-08-22T08:00:00.000Z');
const keys = { current: { id: 'lh-v1', key: 'link-health-cursor-secret-material-32b' } };

test('signed link-health cursor explicitly encodes a null checkedAt bound', () => {
  const signer = createProductLinkHealthCursorSigner(keys);
  const token = signer.sign({
    v: 1,
    purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
    subjectId: 'subject-1',
    filters: { status: null, collectionId: null, duplicate: false, scope: 'owned' },
    limit: 50,
    sort: PRODUCT_LINK_HEALTH_SORT,
    comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: { checkedAt: null, nodeId: 'node-a' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const payload = signer.verify(token, NOW);
  assert.equal(payload.after.checkedAt, null);
  assert.equal(payload.after.nodeId, 'node-a');
  assert.equal(payload.purpose, 'link_health_v1');
  signer.destroy();
});

test('link-health cursor with a timestamp checkedAt round-trips', () => {
  const signer = createProductLinkHealthCursorSigner(keys);
  const checkedAt = '2026-08-22T07:00:00.000Z';
  const token = signer.sign({
    v: 1,
    purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
    subjectId: 'subject-1',
    filters: { status: 'pending', collectionId: null, duplicate: true, scope: 'shared' },
    limit: 20,
    sort: PRODUCT_LINK_HEALTH_SORT,
    comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: { checkedAt, nodeId: 'node-b' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const payload = signer.verify(token, NOW);
  assert.equal(payload.after.checkedAt, checkedAt);
  assert.equal(payload.filters.duplicate, true);
  assert.equal(payload.filters.status, 'pending');
  assert.equal(payload.filters.scope, 'shared');
  signer.destroy();
});

test('legacy three-key owned cursors still verify and omit scope', () => {
  const signer = createProductLinkHealthCursorSigner(keys);
  const token = signer.sign({
    v: 1,
    purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
    subjectId: 'subject-1',
    filters: { status: null, collectionId: null, duplicate: false },
    limit: 50,
    sort: PRODUCT_LINK_HEALTH_SORT,
    comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: { checkedAt: null, nodeId: 'node-a' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  const payload = signer.verify(token, NOW);
  assert.equal(payload.filters.scope, undefined);
  assert.equal(payload.filters.duplicate, false);
  signer.destroy();
});

test('four-key cursor with unknown scope is invalid_cursor', () => {
  const signer = createProductLinkHealthCursorSigner(keys);
  assert.throws(() => signer.sign({
    v: 1,
    purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
    subjectId: 'subject-1',
    filters: { status: null, collectionId: null, duplicate: false, scope: 'mine' as 'owned' },
    limit: 50,
    sort: PRODUCT_LINK_HEALTH_SORT,
    comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: { checkedAt: null, nodeId: 'node-a' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  }));
  signer.destroy();
});

test('tampered link-health cursor is invalid_cursor', () => {
  const signer = createProductLinkHealthCursorSigner(keys);
  const token = signer.sign({
    v: 1,
    purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE,
    subjectId: 'subject-1',
    filters: { status: null, collectionId: null, duplicate: false, scope: 'owned' },
    limit: 50,
    sort: PRODUCT_LINK_HEALTH_SORT,
    comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    after: { checkedAt: null, nodeId: 'node-a' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  assert.throws(() => signer.verify(`${token}x`, NOW), LinkHealthCursorError);
  signer.destroy();
});
