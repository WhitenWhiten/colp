import { expect, test } from 'vitest';
import { managedCopyKey, managedFolderKey, managedLibraryKey, validManagedCopy, type ManagedCopy } from '../src/site-adapters/copy-identity.js';
import { managedCopyKey as serverCopyKey, managedSlotKey } from '../../server/src/modules/source-archives/managed-copies.js';
const content = { site: 'fixture.posts', identityVersion: 1, itemId: 'post:one', accountId: null };
const source = (collection = 'saved'): Extract<ManagedCopy, { purpose: 'sourceArchive' }> => ({ content, purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: collection });
test('each source collection has its own copy while semantic content is shared across source memberships', () => {
  const semantic: ManagedCopy = { content, purpose: 'semantic' };
  expect(new Set([source('A'), source('B'), semantic].map(c => managedCopyKey('library', c))).size).toBe(3);
  expect(managedFolderKey('library', source('A'))).not.toBe(managedFolderKey('library', source('B')));
  expect(managedFolderKey('library', source())).toBe(managedFolderKey('library', { ...source(), content: { ...content, itemId: 'post:two' } }));
  expect(managedCopyKey('library', semantic)).toBe(managedCopyKey('library', structuredClone(semantic)));
});
test('library, site, identity version, private account and source account cannot collide', () => {
  const baseline = managedCopyKey('library', source());
  for (const copy of [{ ...source(), sourceAccount: 'other' }, { ...source(), content: { ...content, site: 'other' } },
    { ...source(), content: { ...content, identityVersion: 2 } }, { ...source(), content: { ...content, accountId: 'reader' } }]) {
    expect(managedCopyKey('library', copy)).not.toBe(baseline);
  }
  expect(managedCopyKey('other-library', source())).not.toBe(baseline);
  expect(managedLibraryKey({ serverOrigin: 'https://one.test/path', accountId: 'a', collectionId: 'c' }))
    .not.toBe(managedLibraryKey({ serverOrigin: 'https://two.test', accountId: 'a', collectionId: 'c' }));
});
test('private content requires the matching source account and transport details cannot enter the identity', () => {
  expect(validManagedCopy({ ...source(), content: { ...content, accountId: 'other' } })).toBe(false);
  for (const extra of [{ nativeId: '1' }, { deviceId: 'device' }, { path: '/renamed' }, { ruleId: 'rule' }]) {
    expect(validManagedCopy({ ...source(), ...extra })).toBe(false);
  }
  expect(() => managedCopyKey('library', { ...source(), sourceCollectionId: '' })).toThrow('invalidManagedCopy');
});
test('all sites use identical portable keys in the browser and the sync service', () => {
  for (const copy of [source(), { content, purpose: 'semantic' as const }, { ...source(), content: { ...content, accountId: 'reader' } }]) {
    expect(managedCopyKey('library', copy)).toBe(serverCopyKey('library', copy));
  }
  expect(managedFolderKey('library', source())).toBe(managedSlotKey('library', { kind: 'folder', source: {
    site: content.site, identityVersion: content.identityVersion, sourceAccount: 'reader', sourceCollectionId: 'saved',
  } }));
});
