import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_PUBLICATION_DIRECTORY_SORT,
  createPublicationDirectoryFilterDigest,
} from '@know-n/colp/server';
import {
  createPublicationCursorKeyring,
  createPublicationModule,
} from '../../../src/modules/publication/index.js';

const oldSecret = Buffer.alloc(32, 31).toString('base64');
const currentSecret = Buffer.alloc(32, 47).toString('base64');

const snapshotContext = {
  collectionId: 'collection-1',
  resourceId: 'https://colp.example/colp/v0.1/collections/collection-1/snapshot',
  revision: 'content-1.policy-1',
  comparatorVersion: 'parent-position-id-v1',
  principal: 'anonymous',
  pageSize: 100,
};
const directoryContext = {
  resourceId: 'https://colp.example/colp/v0.1/collections',
  principal: 'anonymous',
  filterDigest: createPublicationDirectoryFilterDigest({}),
  sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
  limit: 100,
  protocolVersion: '0.1',
};

test('active key signs and retained key verifies across restart and rotation', () => {
  const old = createPublicationCursorKeyring({
    active: { id: 'old', secret: oldSecret },
    retained: [],
  });
  const cursor = old.snapshot.sign({ ...snapshotContext, nextPosition: 'next-1' });
  old.destroy();

  const rotated = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [{ id: 'old', secret: oldSecret }],
  });
  assert.deepEqual(rotated.snapshot.verify(cursor, snapshotContext), {
    valid: true,
    nextPosition: 'next-1',
  });
  const current = rotated.snapshot.sign({ ...snapshotContext, nextPosition: 'next-2' });
  rotated.destroy();

  const restarted = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [{ id: 'old', secret: oldSecret }],
  });
  assert.equal(restarted.snapshot.verify(current, snapshotContext).valid, true);
  assert.equal(restarted.snapshot.verify(cursor, snapshotContext).valid, true);
  restarted.destroy();

  const retired = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [],
  });
  assert.deepEqual(retired.snapshot.verify(cursor, snapshotContext), {
    valid: false,
    code: 'invalid_cursor_scope',
  });
  retired.destroy();
});

test('cursor scopes and derived purposes cannot be replayed', () => {
  const keys = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [],
  });
  const snapshot = keys.snapshot.sign({ ...snapshotContext, nextPosition: 'next' });
  assert.equal(keys.snapshot.verify(snapshot, { ...snapshotContext, principal: 'member-1' }).valid, false);
  assert.equal(keys.snapshot.verify(snapshot, { ...snapshotContext, collectionId: 'collection-2' }).valid, false);
  assert.equal(keys.snapshot.verify(snapshot, { ...snapshotContext, comparatorVersion: 'parent-position-id-v2' }).valid, false);
  assert.equal(keys.directory.verify(snapshot, directoryContext).valid, false);

  const directory = keys.directory.sign({ ...directoryContext, nextPosition: '2026-01-01T00:00:00Z|id' });
  assert.equal(keys.snapshot.verify(directory, snapshotContext).valid, false);

  const productScope = {
    purpose: 'product-public-page',
    collectionId: 'collection-1',
    principal: 'anonymous',
    revision: 'content-1.policy-1',
    limit: 100,
  };
  const product = keys.product.sign({ ...productScope, nextPosition: 'next' });
  assert.equal(keys.product.verify(product, productScope).valid, true);
  assert.equal(keys.product.verify(product, { ...productScope, purpose: 'publication-snapshot' }).valid, false);
  assert.equal(keys.snapshot.verify(product, snapshotContext).valid, false);
  keys.destroy();
});

test('rejects weak, duplicate, and reused deployment keys without exposing secrets', () => {
  for (const config of [
    { active: { id: 'current', secret: Buffer.alloc(8).toString('base64') }, retained: [] },
    { active: { id: 'same', secret: currentSecret }, retained: [{ id: 'same', secret: oldSecret }] },
    { active: { id: 'current', secret: currentSecret }, retained: [{ id: 'old', secret: currentSecret }] },
  ]) {
    let message = '';
    try {
      createPublicationCursorKeyring(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(message.length > 0);
    assert.equal(message.includes(currentSecret), false);
    assert.equal(message.includes(oldSecret), false);
  }
});

test('tamper is rejected and module stop destroys all key handles', async () => {
  const keys = createPublicationCursorKeyring({
    active: { id: 'current', secret: currentSecret },
    retained: [],
  });
  const cursor = keys.snapshot.sign({ ...snapshotContext, nextPosition: 'next' });
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(keys.snapshot.verify(tampered, snapshotContext).valid, false);
  await createPublicationModule(keys).stop();
  assert.equal(keys.destroyed, true);
  assert.throws(() => keys.snapshot.sign({ ...snapshotContext, nextPosition: 'again' }), /destroyed/u);
});
