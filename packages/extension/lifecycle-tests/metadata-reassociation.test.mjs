import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMetadataReassociation, mergeRestoredMetadata } from '../src/metadata-reassociation.js';
const backup = [{ sourceId: 'old-root', parentIndex: null, title: 'Books', description: 'Read' },
  { sourceId: 'old-bookmark', parentIndex: 0, title: 'A', url: 'https://example.test/a', tags: ['a'], note: 'note' }];
const native = [{ id: 'new-root', parentId: null, title: 'Books', url: null, managed: false },
  { id: 'new-bookmark', parentId: 'new-root', title: 'A', url: 'https://example.test/a', managed: false }];
test('reinstallation matches changed native ids using unique path, kind and exact URL', () => {
  assert.deepEqual(planMetadataReassociation(backup, native).matches, [
    { backupIndex: 0, nativeId: 'new-root' }, { backupIndex: 1, nativeId: 'new-bookmark' }]);
});
test('reused ids, same URLs in another folder and renamed bookmarks are never identity proof', () => {
  for (const changes of [{ title: 'Different' }, { url: 'https://example.test/a?private=1' }, { parentId: null }]) {
    const result = planMetadataReassociation(backup, [native[0], { ...native[1], id: 'old-bookmark', ...changes }]);
    assert.equal(result.matches.length, 1); assert.equal(result.unmatched, 1);
  }
});
test('duplicate target or source identities remain ambiguous and are skipped', () => {
  const result = planMetadataReassociation(backup, [...native, { ...native[1], id: 'copy' }]);
  assert.equal(result.ambiguous, 1); assert.equal(result.matches.length, 1);
  const source = planMetadataReassociation([...backup, { ...backup[1], sourceId: 'copy' }], native);
  assert.equal(source.ambiguous, 2); assert.equal(source.matches.length, 1);
});
test('managed and subscription ancestors exclude all descendants', () => {
  assert.equal(planMetadataReassociation(backup, native, new Set(['new-root'])).matches.length, 0);
  assert.equal(planMetadataReassociation(backup, [{ ...native[0], managed: true }, native[1]]).matches.length, 0);
});
test('malformed or cyclic ancestry fails closed', () => {
  assert.throws(() => planMetadataReassociation([{ ...backup[0], parentIndex: 1 }], native));
  assert.throws(() => planMetadataReassociation(backup, [{ ...native[0], parentId: 'new-bookmark' }, native[1]]));
  assert.throws(() => planMetadataReassociation(backup, [native[0], { ...native[1], parentId: 'missing' }]));
});
test('restore merges tags losslessly, keeps conflicting drafts and is idempotent', () => {
  const current = { tags: ['mine'], note: 'my note', description: 'my description' };
  const restored = mergeRestoredMetadata(current, { ...backup[1], description: 'other' });
  assert.deepEqual(restored.tags, ['mine', 'a']); assert.equal(restored.note, 'my note');
  assert.equal(restored.description, 'my description'); assert.deepEqual(restored.conflicts, ['note', 'description']);
  assert.deepEqual(mergeRestoredMetadata(restored, { ...backup[1], description: 'other' }), restored);
  const overflow = mergeRestoredMetadata(current, backup[1], 1);
  assert.deepEqual(overflow.tags, ['mine']); assert.ok(overflow.conflicts.includes('tags'));
});
test('empty current fields can be filled without overwriting other metadata', () => {
  assert.deepEqual(mergeRestoredMetadata({ tags: [], note: null, description: null }, backup[1]),
    { tags: ['a'], note: 'note', description: null, conflicts: [] });
});
