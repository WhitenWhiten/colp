import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncConfirmations, trustedLifecyclePage, validPersonalSyncCommand } from '../src/personal-sync-commands.js';
import { createRememberedConnectionStore, parseRememberedConnection } from '../src/personal-sync-connection.js';
const basis = { accountKey: 'a', generation: 1, revision: 'one', collectionId: 'collection', digest: 'tree-and-queue' };
test('strict commands reject unknown keys, missing gestures and unconfirmed destructive operations', () => {
  assert.equal(validPersonalSyncCommand({ kind: 'known.personalSync.status' }), true);
  assert.equal(validPersonalSyncCommand({ kind: 'known.personalSync.change', action: 'pause', revision: 'legacy', userGesture: true }), true);
  for (const value of [null, [], { kind: 'known.personalSync.status', accountId: 'other' },
    { kind: 'known.personalSync.preview', action: ['resume'] },
    { kind: 'known.personalSync.change', action: 'pause', revision: 'one', userGesture: false },
    { kind: 'known.personalSync.change', action: 'disconnect', revision: 'one', userGesture: true }]) assert.equal(validPersonalSyncCommand(value), false);
});
test('only the exact extension options page can change lifecycle policy', () => {
  assert.equal(trustedLifecyclePage({ id: 'ext', url: 'chrome-extension://ext/options.html#sync' }, 'ext'), true);
  for (const url of ['https://ext/options.html', 'chrome-extension://ext/popup.html', 'chrome-extension://ext/options.html/extra', 'chrome-extension://other/options.html']) {
    assert.equal(trustedLifecyclePage({ id: 'ext', url }, 'ext'), false);
  }
  assert.equal(trustedLifecyclePage({ id: 'other', url: 'chrome-extension://ext/options.html' }, 'ext'), false);
});
test('tokens are single-use and invalidate on account, generation, tree, target or policy changes', () => {
  const gate = createSyncConfirmations();
  for (const field of Object.keys(basis)) {
    const token = gate.issue('resume', basis);
    assert.throws(() => gate.consume(token, 'resume', { ...basis, [field]: field === 'generation' ? 2 : 'changed' }), /preview_stale/);
    assert.throws(() => gate.consume(token, 'resume', basis), /preview_stale/);
  }
  const token = gate.issue('disconnect', basis); gate.consume(token, 'disconnect', basis);
  assert.throws(() => gate.consume(token, 'disconnect', basis), /preview_stale/);
});
test('cancelled, expired, cross-action and pre-restart confirmations cannot execute', () => {
  let now = 1000; const gate = createSyncConfirmations(() => now);
  const token = gate.issue('resume', basis); assert.throws(() => gate.consume(token, 'disconnect', basis));
  const expired = gate.issue('resume', basis); now += 120000; assert.throws(() => gate.consume(expired, 'resume', basis));
  const old = gate.issue('resume', basis); assert.throws(() => createSyncConfirmations().consume(old, 'resume', basis));
});
test('remembered connections carry only allowlisted non-secret identity and remain account-scoped', async () => {
  const data = {}, storage = { async get(key) { return data; }, async set(items) { Object.assign(data, items); } };
  const store = createRememberedConnectionStore(storage), identity = { serverOrigin: 'https://known.test', accountId: 'a', collectionId: 'one' };
  const connection = { version: 1, collectionId: 'one', binding: { replicaId: 'replica', browserProfileId: 'profile', generation: '1' } };
  await store.write(identity, connection); assert.deepEqual(await store.read(identity), connection);
  assert.equal(await store.read({ ...identity, accountId: 'b' }), null);
  assert.equal(parseRememberedConnection({ ...connection, token: 'secret' }), null);
  assert.equal(parseRememberedConnection({ ...connection, binding: { ...connection.binding, accessToken: 'secret' } }), null);
  assert.equal(parseRememberedConnection({ ...connection, binding: { ...connection.binding, generation: '-1' } }), null);
  await assert.rejects(store.write({ ...identity, collectionId: 'two' }, connection));
  await store.write(identity, null); assert.equal(await store.read(identity), null);
});
