import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test('pull does not pass file or chrome urls to chrome.bookmarks.create or update; https still is', async () => {
  const fixture = await setup();
  const writes: unknown[] = [];
  const create = fixture.api.create.bind(fixture.api);
  const update = fixture.api.update.bind(fixture.api);
  fixture.api.create = async (input) => { writes.push(input); return create(input); };
  fixture.api.update = async (id, changes) => { writes.push({ id, changes }); return update(id, changes); };
  const collectionId = scope.collectionId;
  const parentId = 'root-colp';
  try {
    await fixture.applier.stage(fixture.page([
      pullFixtures.mutationEvent({ kind: 'update', sequence: 201, collectionId, targetId: 'node-1', parentId,
        url: 'https://example.test/kept' }),
      pullFixtures.createEvent({ kind: 'Bookmark', sequence: 203, collectionId, parentId, url: 'https://example.test/created' }),
      pullFixtures.createEvent({ kind: 'Bookmark', sequence: 204, collectionId, parentId, url: 'file:///tmp/secret' }),
      pullFixtures.createEvent({ kind: 'Bookmark', sequence: 205, collectionId, parentId, url: 'chrome://settings' }),
      pullFixtures.mutationEvent({ kind: 'update', sequence: 206, collectionId, targetId: 'node-1', parentId,
        url: 'file:///etc/passwd' }),
      pullFixtures.createEvent({ kind: 'Folder', sequence: 202, collectionId, parentId }),
    ], 'cursor-schemes'));
    await fixture.applier.resume();
    const rendered = JSON.stringify(writes);
    assert.equal(rendered.includes('file:'), false);
    assert.equal(rendered.includes('chrome:'), false);
    assert.equal(rendered.includes('https://example.test/kept'), true);
    assert.equal(rendered.includes('https://example.test/created'), true);
    assert.equal(fixture.api.getNode('native-node')?.url, 'https://example.test/kept');
    assert.equal(fixture.api.all().some((node) => String(node.url).startsWith('file:') || String(node.url).startsWith('chrome:')), false);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-schemes');
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => [issue.nodeId, issue.code]).sort(), [
      ['node-1', 'unsupported_url_scheme'],
      ['node-created-204', 'unsupported_url_scheme'],
      ['node-created-205', 'unsupported_url_scheme'],
    ]);
  } finally { fixture.store.close(); }
});
