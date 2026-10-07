import { expect, test } from 'vitest';
import { createProductAnnotationCursorSigner, getProductCollectionNotes, type ProductAnnotationReadPorts, type ProductAnnotationRow } from '../../../src/modules/collections/index.js';

function fixture() {
  let revision = 'r1';
  const rows: ProductAnnotationRow[] = Array.from({ length: 101 }, (_, index) => ({ id: `note-${index}`, collectionId: 'c', subjectType: 'node', subjectId: `n-${index}`,
    creatorPrincipalId: 'principal', resourceRevision: 'note-r1', deletedAt: null, updatedAt: new Date('2026-09-01T00:00:00Z'),
    payload: { id: `note-${index}`, collectionId: 'c', subject: { type: 'node', id: `n-${index}` }, type: 'note', format: 'plain', value: 'Private', visibility: 'private',
      creator: { id: 'https://known.test/profiles/owner' }, revision: 'note-r1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' } }));
  const ports: ProductAnnotationReadPorts = { clock: { now: async () => new Date('2026-10-02T00:00:00Z') },
    accessPolicy: { loadCollectionFacts: async () => ({ collectionId: 'c', ownerSubjectId: 'owner', policyRevision: 'p1', membershipRole: null, visibility: 'private', deleted: false }) },
    cursorSigner: createProductAnnotationCursorSigner({ current: { id: 'test', key: 'collection-notes-test-secret' } }),
    reads: { loadLiveSubject: async () => null, loadLiveById: async () => null, listLiveBySubject: async () => [],
      collectionNotesRevision: async () => revision, listPrivateCollectionNotes: async ({ after }) => after ? rows.slice(100) : rows },
  };
  return { ports, setRevision: (value: string) => { revision = value; } };
}
const input = { collectionId: 'c', actor: { principalId: 'principal', subjectId: 'owner' } };
test('collection notes paginate in a distinct signed scope and unchanged snapshots are cheap', async () => {
  const f = fixture(), first = await getProductCollectionNotes(f.ports, input);
  expect(first.annotations).toHaveLength(100); expect(first.page.hasMore).toBe(true);
  expect((await getProductCollectionNotes(f.ports, { ...input, cursor: first.page.nextCursor! })).annotations).toHaveLength(1);
  expect(await getProductCollectionNotes(f.ports, { ...input, knownRevision: 'r1' })).toMatchObject({ unchanged: true, annotations: [] });
  f.setRevision('r2'); await expect(getProductCollectionNotes(f.ports, { ...input, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor' });
});
test('foreign actors cannot read or reuse an owner notes snapshot', async () => {
  const f = fixture();
  await expect(getProductCollectionNotes(f.ports, { ...input, actor: { principalId: 'member', subjectId: 'member' }, knownRevision: 'r1' })).rejects.toMatchObject({ code: 'annotation_not_found' });
});
