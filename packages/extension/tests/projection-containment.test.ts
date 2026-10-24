/**
 * B-04 / W2C-11: a bookmark that cannot be projected into Chrome stays one bookmark.
 * Fixture: `tests/recovery-projection-chrome-fixture.ts` (shared, untouched).
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { BookmarkApiError } from '../src/bookmark-api-error.js';
import { executeNativeCreate } from '../src/native-create-executor.js';
import { executeProjectionIntents, projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../src/recovery-overlay.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server-pc', serverOrigin: 'https://known.example',
  accountId: 'account-pc', browserProfileId: 'profile-pc', collectionId: 'collection-pc',
  replicaId: 'replica-pc', generation: 1,
};
const parent: MappingInput = { nativeId: '1', colpId: 'folder-colp', rootNativeId: '1', nodeKind: 'folder',
  projection: { revision: 'r1', digest: 'd-parent', content: { title: 'Parent' } } };

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const node = (colpId: string, title: string, parentColpId = 'folder-colp', folder = false): MappingInput => ({
  nativeId: `recovery:${colpId}`, colpId, rootNativeId: '1', nodeKind: folder ? 'folder' : 'bookmark', parentColpId,
  projection: { revision: 'r2', digest: `sha256:${colpId}`,
    content: folder ? { title } : { title, url: `https://example.test/${colpId}` } } });
const refusal = (message: string) => new BookmarkApiError('other_failure', message);
const nextWake = () => vi.setSystemTime(Date.now() + 6_000);

async function ready() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-pc', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['folder-colp'], rootStatus: 'ready' });
  await store.putMapping(scope, parent);
  return { store, chrome: fakeChrome([{ id: '1', title: 'Parent' }]) };
}
const project = (fixture: Awaited<ReturnType<typeof ready>>, bound: readonly MappingInput[]) =>
  projectVirtualSnapshotChildren({ scope, store: fixture.store, api: fixture.chrome.api, bound });

test('one create Chrome refuses never blocks its siblings; it is counted per wake and named on the third', async () => {
  const fixture = await ready(); const { store, chrome } = fixture;
  const original = chrome.api.create.bind(chrome.api); let refused = 0;
  chrome.api.create = async (input) => { if (input.title === 'BAD') { refused += 1; throw refusal('Index out of bounds.'); } return original(input); };
  const bound = [parent, node('a', 'BAD'), node('b', 'good-b'), node('c', 'good-c')];
  await project(fixture, bound);
  assert.equal(chrome.creates, 2, 'b and c are created in the same pass');
  let intents = await store.listProjectionIntents(scope);
  assert.deepEqual(intents.map((intent) => [intent.colpId, intent.state]), [['a', 'pending'], ['b', 'terminal'], ['c', 'terminal']]);
  assert.equal((await store.listLocalIssues(scope)).length, 0, 'one refusal is a retry');
  nextWake(); await project(fixture, bound);
  assert.equal((await store.listLocalIssues(scope)).length, 0, 'two wakes of the same refusal are still a retry');
  nextWake(); await project(fixture, bound);
  const issues = await store.listLocalIssues(scope);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.nativeId, issue.title]),
    [['apply_failed:bookmark_api_error', 'recovery:a', 'BAD']]);
  assert.equal(refused, 3);
  nextWake(); await project(fixture, bound);
  assert.equal(refused, 3, 'a named bookmark is not retried on every pass');
  intents = await store.listProjectionIntents(scope);
  assert.equal(intents.find((intent) => intent.colpId === 'b')?.state, 'terminal');
});

test('a refusal that stops by itself projects the bookmark on the next wake and leaves no issue', async () => {
  const fixture = await ready(); const { store, chrome } = fixture;
  const original = chrome.api.create.bind(chrome.api); let refusals = 0;
  chrome.api.create = async (input) => { if (refusals < 1) { refusals += 1; throw refusal('Index out of bounds.'); } return original(input); };
  const bound = [parent, node('a', 'only')];
  await project(fixture, bound);
  assert.match((await store.getMappingByColpId(scope, 'a'))?.nativeId ?? '', /^recovery:/u);
  nextWake(); await project(fixture, bound);
  assert.ok(!(await store.getMappingByColpId(scope, 'a'))!.nativeId.startsWith('recovery:'));
  assert.equal((await store.listLocalIssues(scope)).length, 0);
});

test('the children of a folder Chrome refuses wait quietly: only the folder is named, not every descendant', async () => {
  const fixture = await ready(); const { store, chrome } = fixture;
  const original = chrome.api.create.bind(chrome.api);
  chrome.api.create = async (input) => { if (input.title === 'BAD-FOLDER') throw refusal('Index out of bounds.'); return original(input); };
  const bound = [parent, node('f', 'BAD-FOLDER', 'folder-colp', true), node('c1', 'one', 'f'), node('c2', 'two', 'f'), node('s', 'sibling')];
  for (let wake = 0; wake < 4; wake += 1) { await project(fixture, bound); nextWake(); }
  const issues = await store.listLocalIssues(scope);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.title]), [['apply_failed:bookmark_api_error', 'BAD-FOLDER']]);
  assert.ok(!(await store.getMappingByColpId(scope, 's'))!.nativeId.startsWith('recovery:'), 'the independent sibling projected');
  assert.equal(chrome.creates, 1, 'nothing under the refused folder was created');
});

test('a lost bookmark permission is not contained: the projection stops and keeps its retryable state', async () => {
  const fixture = await ready(); const { store, chrome } = fixture;
  chrome.api.create = async () => { throw new BookmarkApiError('permission_denied', 'permission_required'); };
  await assert.rejects(() => project(fixture, [parent, node('a', 'x')]), /permission_revoked/u);
  assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'recovery');
  assert.equal((await store.listLocalIssues(scope)).length, 0);
});

test('the receipt of a create that already happened answers before the equal-content check (B-04)', async () => {
  const { store, chrome } = await ready();
  const url = 'https://example.test/equal';
  const intent = (colpId: string, order: number, state: ProjectionIntentRecord['state']): ProjectionIntentRecord => ({
    intentId: `create:${colpId}`, kind: 'create', colpId, order, generation: 1,
    suppression: createProjectionSuppression('1', 'Equal content', url), parentColpId: 'folder-colp', parentNativeId: '1',
    title: 'Equal content', url, folder: false, state });
  await store.replaceProjectionIntents(scope, [intent('a', 1, 'executing'), intent('b', 2, 'pending')]);
  // The worker created the bookmark and stored the receipt, then was killed before the intent learned the id.
  await assert.rejects(() => executeNativeCreate({ scope, store, api: chrome.api, intentId: 'projection:create:a',
    owner: { scopeKey: scopeKey(scope), generation: 1, commandId: 'projection', eventId: 'create:a', colpId: 'a', substep: 'projection' },
    parentNativeId: '1', expected: { title: 'Equal content', url }, liveWorkKind: 'create',
    create: () => chrome.api.create({ parentId: '1', title: 'Equal content', url }),
    crash: (boundary) => { if (boundary === 'after_evidence_before_mapping') throw new Error('worker_crash'); } }), /worker_crash/u);
  assert.equal(chrome.creates, 1);
  const equal = (colpId: string) => node(colpId, 'Equal content');
  const projected = await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1',
    seedMappings: [parent, { ...equal('a'), projection: { ...equal('a').projection, content: { title: 'Equal content', url } } },
      { ...equal('b'), projection: { ...equal('b').projection, content: { title: 'Equal content', url } } }] });
  assert.equal(projected.find((mapping) => mapping.colpId === 'a')?.nativeId, '2', 'the created bookmark is reused, not called unknown');
  assert.notEqual(projected.find((mapping) => mapping.colpId === 'b')?.nativeId, '2');
  assert.equal(chrome.creates, 2, 'one more create, for b only');
  assert.equal((await store.listLocalIssues(scope)).length, 0);
});

test('a target that vanished from Chrome is named for that bookmark and does not abort the others (W2C-11)', async () => {
  const { store, chrome } = await ready();
  const gone: MappingInput = { nativeId: '5', colpId: 'gone', rootNativeId: '1', nodeKind: 'bookmark', parentColpId: 'folder-colp',
    parentNativeId: '1', projection: { revision: 'r1', digest: 'd-gone', content: { title: 'Old', url: 'https://example.test/old' } } };
  await store.putMapping(scope, gone);
  await store.replaceProjectionIntents(scope, [
    { intentId: 'update:gone', kind: 'update', colpId: 'gone', order: 1, generation: 1, state: 'pending', nativeId: '5',
      suppression: 'recovery:update:gone', title: 'New' },
    { intentId: 'create:s', kind: 'create', colpId: 's', order: 2, generation: 1, state: 'pending',
      suppression: createProjectionSuppression('1', 's', 'https://example.test/s'), parentColpId: 'folder-colp',
      parentNativeId: '1', title: 's', url: 'https://example.test/s', folder: false }]);
  const projected = await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1',
    seedMappings: [parent, { ...gone, projection: { ...gone.projection, content: { title: 'New', url: 'https://example.test/old' } } }, node('s', 's')] });
  assert.deepEqual((await store.listLocalIssues(scope)).map((issue) => [issue.code, issue.nativeId]),
    [['snapshot_content_target_missing', '5']]);
  assert.ok(!projected.find((mapping) => mapping.colpId === 's')!.nativeId.startsWith('recovery:'), 'the independent create ran');
  assert.equal((await store.listProjectionIntents(scope)).find((intent) => intent.colpId === 'gone')?.state, 'pending');
});
