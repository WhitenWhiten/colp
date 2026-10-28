import { expect, test } from 'vitest';
import { localSourceCopyKey, localSourceScopeId, transferOwner } from '../src/site-adapters/local-identity.js';
import type { NativeBinding } from '../src/site-adapters/contracts.js';
import type { ManagedSlot } from '../src/site-adapters/managed-client.js';
const root: NativeBinding<'folder'> = { deviceId: 'device', nativeId: 'folder', dateAdded: 10, kind: 'folder', bindingId: 'proof', proof: { kind: 'explicitAdoption', id: 'proof' } };
const slot: ManagedSlot = { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved',
  content: { site: 'fixture', identityVersion: 1, itemId: 'one', accountId: null } } };
test('local identity survives cloud owner changes while retaining exact native creation identity', () => {
  const key = localSourceCopyKey(root, slot);
  const owner = { serverOrigin: 'https://sync.test/', accountId: 'a', collectionId: 'library' };
  const pinned = transferOwner(owner); owner.accountId = 'b';
  expect(pinned?.accountId).toBe('a'); expect(transferOwner(owner)?.accountId).toBe('b');
  expect(localSourceCopyKey(root, slot)).toBe(key);
  expect(localSourceCopyKey({ ...root, dateAdded: 11 }, slot)).not.toBe(key);
  expect(localSourceCopyKey({ ...root, deviceId: 'other' }, slot)).not.toBe(key);
  expect(localSourceScopeId('device')).toBe('["local","device"]');
});
test('local copy identities separate source accounts and copy purposes without a server binding', () => {
  if (slot.kind !== 'bookmark' || slot.copy.purpose !== 'sourceArchive') throw Error('fixture');
  const key = localSourceCopyKey(root, slot);
  expect(localSourceCopyKey(root, { ...slot, copy: { ...slot.copy, sourceAccount: 'other' } })).not.toBe(key);
  expect(localSourceCopyKey(root, { kind: 'bookmark', copy: { purpose: 'semantic', content: slot.copy.content } })).not.toBe(key);
  expect(transferOwner(null)).toBeNull();
  expect(transferOwner({ serverOrigin: 'https://sync.test', accountId: null, collectionId: null })).toBeNull();
});
