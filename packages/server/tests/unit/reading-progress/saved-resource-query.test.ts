import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSavedResourceCursorSigner, getSavedResourcePage,
  type SavedResourceReadPorts, type SavedResourceQueryRow } from '../../../src/modules/reading-progress/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-07-25T12:00:00.000Z');
const actor = { accountId: 'account-a', principalId: 'principal-a', subjectId: 'subject-a' };
function row(id: string, savedAt: string, type: 'collection' | 'node' = 'node'): SavedResourceQueryRow {
  return { resourceType: type, resourceId: id, savedAt: new Date(savedAt) };
}
function ports(rows: readonly SavedResourceQueryRow[], options: { account?: string; now?: Date } = {}): SavedResourceReadPorts {
  return {
    clock: { now: async () => options.now ?? NOW },
    cursorSigner: createSavedResourceCursorSigner({ current: { id: 'saved-v1', key: 'saved-cursor-secret-material' } }),
    reads: {
      async listLive(input) {
        assert.equal(input.accountId, options.account ?? 'account-a');
        const after = input.after;
        return rows.filter((candidate) => !after || candidate.savedAt < new Date(after.savedAt)
          || (candidate.savedAt.getTime() === Date.parse(after.savedAt)
            && (candidate.resourceType > after.resourceType
              || (candidate.resourceType === after.resourceType && candidate.resourceId > after.resourceId))))
          .slice(0, input.limit + 1);
      },
      async hydrateAccessible(input) {
        return input.targets.filter((target) => target.resourceId !== 'hidden').map((target) => ({ ...target,
          collectionId: target.resourceType === 'collection' ? target.resourceId : 'collection-a',
          title: `Title ${target.resourceId}`, url: target.resourceType === 'node' ? 'https://example.test' : null }));
      },
    },
  };
}

test('saved resource pages traverse a complete stable tuple and batch-hydrate unavailable targets', async () => {
  const rows = [row('collection-a', '2026-07-25T11:00:00.000Z', 'collection'),
    row('a', '2026-07-25T11:00:00.000Z'), row('b', '2026-07-25T11:00:00.000Z'),
    row('hidden', '2026-07-25T10:00:00.000Z'), row('c', '2026-07-25T09:00:00.000Z', 'collection')];
  const first = await getSavedResourcePage(ports(rows), { actor, limit: 2 });
  const second = await getSavedResourcePage(ports(rows), { actor, cursor: first.page.nextCursor! });
  const third = await getSavedResourcePage(ports(rows), { actor, cursor: second.page.nextCursor! });
  const items = [...first.items, ...second.items, ...third.items];
  assert.deepEqual(items.map((item) => `${item.resourceType}:${item.resourceId}`),
    ['collection:collection-a', 'node:a', 'node:b', 'node:hidden', 'collection:c']);
  assert.deepEqual(items[3]?.target, { availability: 'unavailable', collectionId: null, title: null, url: null });
  assert.equal(new Set(items.map((item) => `${item.resourceType}:${item.resourceId}`)).size, rows.length);
});

test('live-set pagination omits a newly saved row before the boundary and an unsaved row after it', async () => {
  let rows = [row('a', '2026-07-25T11:00:00.000Z'), row('b', '2026-07-25T10:00:00.000Z'),
    row('c', '2026-07-25T09:00:00.000Z')];
  const value = ports(rows); value.reads.listLive = async (input) => {
    const after = input.after;
    return rows.filter((candidate) => !after || candidate.savedAt < new Date(after.savedAt)
      || (candidate.savedAt.getTime() === Date.parse(after.savedAt) && (candidate.resourceType > after.resourceType
        || (candidate.resourceType === after.resourceType && candidate.resourceId > after.resourceId))))
      .slice(0, input.limit + 1);
  };
  const first = await getSavedResourcePage(value, { actor, limit: 1 });
  rows = [row('new', '2026-07-25T11:30:00.000Z'), rows[0]!, rows[2]!];
  const second = await getSavedResourcePage(value, { actor, cursor: first.page.nextCursor! });
  assert.deepEqual([...first.items, ...second.items].map((item) => item.resourceId), ['a', 'c']);
});

test('cursor is account/filter/limit/purpose bound and rejects tamper, expiry, and unknown rotation keys', async () => {
  const rows = [row('a', '2026-07-25T11:00:00.000Z'), row('b', '2026-07-25T10:00:00.000Z')];
  const first = await getSavedResourcePage(ports(rows), { actor, limit: 1, resourceType: 'node', collectionId: 'collection-a',
    createdAfter: '2026-07-20T00:00:00.000Z', createdBefore: '2026-07-26T00:00:00.000Z' });
  for (const changed of [
    { actor: { ...actor, accountId: 'account-b' } }, { resourceType: 'collection' as const },
    { collectionId: 'collection-b' }, { createdAfter: '2026-07-21T00:00:00.000Z' },
  ]) await assert.rejects(getSavedResourcePage(ports(rows), { actor, cursor: first.page.nextCursor!,
    resourceType: 'node', collectionId: 'collection-a', createdAfter: '2026-07-20T00:00:00.000Z',
    createdBefore: '2026-07-26T00:00:00.000Z', ...changed }), /cursor/i);
  await assert.rejects(getSavedResourcePage(ports(rows), { actor,
    cursor: `${first.page.nextCursor!.slice(0, -1)}x`, resourceType: 'node', collectionId: 'collection-a',
    createdAfter: '2026-07-20T00:00:00.000Z', createdBefore: '2026-07-26T00:00:00.000Z' }), /cursor/i);
  await assert.rejects(getSavedResourcePage(ports(rows, { now: new Date('2026-07-25T12:16:00.000Z') }), { actor,
    cursor: first.page.nextCursor!, resourceType: 'node', collectionId: 'collection-a',
    createdAfter: '2026-07-20T00:00:00.000Z', createdBefore: '2026-07-26T00:00:00.000Z' }), /cursor/i);

  const oldPorts = ports(rows); oldPorts.cursorSigner = createSavedResourceCursorSigner({
    current: { id: 'saved-old', key: 'saved-old-cursor-secret' },
  });
  const oldPage = await getSavedResourcePage(oldPorts, { actor, limit: 1 });
  const rotated = ports(rows); rotated.cursorSigner = createSavedResourceCursorSigner({
    current: { id: 'saved-new', key: 'saved-new-cursor-secret' },
    previous: [{ id: 'saved-old', key: 'saved-old-cursor-secret', retainUntil: '2026-07-25T12:20:00.000Z' }],
  });
  assert.equal((await getSavedResourcePage(rotated, { actor, cursor: oldPage.page.nextCursor! })).items[0]?.resourceId, 'b');

  const editorCursor = createProductEditorCursorSigner({ current: { id: 'saved-v1', key: 'saved-cursor-secret-material' } }).sign({
    v: 1, purpose: 'product-editor-cursor', principalId: actor.principalId, collectionId: 'collection-a', limit: 1,
    comparatorVersion: 'v1', after: { parentKey: '', positionKey: '', nodeId: 'a' }, contentRevision: 'c1',
    policyRevision: 'p1', snapshotId: 's1', issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
  });
  await assert.rejects(getSavedResourcePage(ports(rows), { actor, cursor: editorCursor }), /cursor/i);
});

test('title changes do not affect saved ordering and filters are passed to the identity query', async () => {
  let observed: unknown;
  const value = ports([row('a', '2026-07-25T11:00:00.000Z')]);
  value.reads.listLive = async (input) => { observed = input; return [row('a', '2026-07-25T11:00:00.000Z')]; };
  const page = await getSavedResourcePage(value, { actor, resourceType: 'node', collectionId: 'collection-a',
    createdAfter: '2026-07-20T00:00:00.000Z', createdBefore: '2026-07-26T00:00:00.000Z' });
  assert.equal(page.items[0]?.target.title, 'Title a');
  assert.deepEqual(observed, { accountId: 'account-a', resourceType: 'node', collectionId: 'collection-a',
    createdAfter: new Date('2026-07-20T00:00:00.000Z'), createdBefore: new Date('2026-07-26T00:00:00.000Z'), limit: 20 });
});
