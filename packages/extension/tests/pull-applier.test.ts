import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createAuthorityFence } from '../src/authority-fence.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-pull', serverOrigin: 'https://known.example',
  accountId: 'account-pull', browserProfileId: 'profile-pull', collectionId: 'collection-pull',
  replicaId: 'replica-receiver', generation: 1 };
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-32 durable Pull authority', () => {
  test('stages a complete validated page before mutation and advances cursor only after every event commits', async () => {
    const fixture = await setup(); const page = fixture.page([fixture.createEvent('Bookmark'),
      fixture.createEvent('Folder', 2, 'node-created-1')]);
    await fixture.applier.stage(page);
    assert.equal(fixture.api.calls.length, 0);
    assert.equal((await fixture.store.exportScope(scope)).scope?.checkpoint?.cursor, 'cursor-old');
    assert.equal((await fixture.store.exportScope(scope)).pullEvents.length, 2);
    await fixture.applier.resume();
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, page.nextCursor);
    assert.equal((await fixture.store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
  });

  test('accepts only exact cursor identity for an ordinary empty Pull page', async () => {
    const fixture = await setup();
    const empty = pullFixtures.page({ events: [], nextCursor: 'cursor-old',
      collectionRevision: 'revision-old' });
    await fixture.applier.stage(empty);
    await fixture.applier.resume();
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-old');

    const drifted = pullFixtures.page({ events: [], nextCursor: 'cursor-resigned-same-tuple',
      collectionRevision: 'revision-old' });
    await assert.rejects(() => fixture.applier.stage(drifted), /pull_cursor_chain_invalid/);

    await fixture.applier.stage(drifted, { reissued: true });
    await fixture.applier.resume();
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-resigned-same-tuple');
    await assert.rejects(() => fixture.applier.stage(pullFixtures.page({ events: [],
      nextCursor: 'cursor-resigned-same-tuple', collectionRevision: 'revision-old' }), { reissued: true }),
    /pull_cursor_chain_invalid/);
  });

  test('SYNC-F011 the awaiting-confirmation probe reports false for empty and committed scopes', async () => {
    const fixture = await setup();
    assert.equal(await fixture.store.hasPullEventsAwaitingConfirmation(scope), false,
      'empty scope reports no awaiting confirmation');
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    await fixture.applier.resume();
    // A fully applied page (events at authority_committed) must NOT report
    // awaiting confirmation — no false positives; the true path is exercised
    // continuously by the engine pull-loop tests that gate on this probe.
    assert.equal(await fixture.store.hasPullEventsAwaitingConfirmation(scope), false,
      'committed events must not report awaiting confirmation');
  });

  test('SYNC-F016 a page with a child before its parent in the same page is rejected loudly (ordering contract)', async () => {
    const fixture = await setup();
    // Two independent sibling chains concretely expressed: folder root +
    // bookmark child (chain A) and bookmark root + bookmark child (chain B),
    // with the child event placed BEFORE its parent in event order. The
    // applier must reject the page loudly (preflight_parent_mapping_missing),
    // not silently reorder or half-apply.
    const childA = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 3,
      collectionId: scope.collectionId, parentId: 'node-created-1' });
    const rootB = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 2,
      collectionId: scope.collectionId, parentId: 'root-colp' });
    const childB = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 4,
      collectionId: scope.collectionId, parentId: 'node-created-2' });
    const folderA = pullFixtures.createEvent({ kind: 'Folder', sequence: 1,
      collectionId: scope.collectionId, parentId: 'root-colp' });
    const outOfOrder = pullFixtures.page({ events: [childA, rootB, childB, folderA],
      nextCursor: 'cursor-double', collectionRevision: 'revision-2' });
    await assert.rejects(() => fixture.applier.stage(outOfOrder), /preflight_parent_mapping_missing/);
  });

  test('FRR-03: identical local siblings stay independent and do not freeze the scope', async () => {
    const fixture = await setup();
    fixture.api.seed({ id: 'native-dup', parentId: 'native-root', index: 0,
      title: 'Remote', url: 'https://example.test/' });
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    await fixture.applier.resume();
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-1'));
    assert.equal((await fixture.api.getChildren('native-root'))
      .filter((node) => node.title === 'Remote' && node.url === 'https://example.test/').length, 2);
  });

  test.each(['Folder', 'Bookmark', 'Separator'] as const)('applies remote create for %s without an echo', async (kind) => {
    const fixture = await setup(); await fixture.applier.stage(fixture.page([fixture.createEvent(kind)]));
    await fixture.applier.resume();
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
    if (kind === 'Separator') assert.equal(fixture.api.calls.length, 0);
    else assert.equal(fixture.api.calls[0]?.kind, 'create');
  });

  test('preserves unknown protocol extensions in the durable projection without sending them to Chrome', async () => {
    const fixture = await setup(); const marker = { marker: 'p3-38-extension-marker' };
    const event: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 91, collectionId: scope.collectionId,
      parentId: 'root-colp', extensions: { 'https://unknown.example/extension': marker } });
    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();
    const mapping = await fixture.store.getMappingByColpId(scope, event.effect.node.id);
    assert.deepEqual(mapping?.projection.content?.extensions, { 'https://unknown.example/extension': marker });
    assert.equal(JSON.stringify(fixture.api.calls).includes('p3-38-extension-marker'), false);
  });

  test('commits an authoritative self-create echo without a second browser mutation', async () => {
    const fixture = await setup(); const event: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 41,
      collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId });
    await fixture.store.putMapping(scope, fixture.mapping('native-self', event.effect.node.id, 'native-root'));
    fixture.api.seed({ id: 'native-self', parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/' });
    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-self'))?.colpId, event.effect.node.id);
  });

  test('advances the local sequence floor past authoritative operations from the same Replica lane', async () => {
    const fixture = await setup(); const event: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 4,
      collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId });
    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();
    const queued = await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId: 'after-resolution-op', batchId: 'after-resolution-batch', idempotencyKey: 'after-resolution-key',
      digest: 'sha256:after-resolution', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'after-resolution-r1', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node' },
    }, { allowUnstamped: true });
    assert.equal(queued.sequence, 5);
  });

  test('rebinds an unsettled own-create echo to its provisional mapping instead of duplicating the bookmark', async () => {
    // The push reached the server but the response was lost: the queue row is
    // still unknown and the local mapping still carries pending-<opId>. The
    // echo must adopt that mapping — a second chrome.bookmarks.create here
    // used to duplicate the bookmark and then freeze the replica as
    // create_ambiguous once two identical candidates existed.
    const fixture = await setup(); const event: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 61,
      collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId });
    const expected = event.effect.node as { title: string; url?: string };
    await fixture.store.putMapping(scope, { nativeId: 'native-inflight', colpId: `pending-${event.operation.opId}`,
      rootNativeId: 'native-root', nodeKind: 'bookmark', parentNativeId: 'native-root',
      projection: { revision: `local-${event.operation.opId}`, digest: 'sha256:inflight',
        content: { title: expected.title, url: expected.url ?? '' } } });
    fixture.api.seed({ id: 'native-inflight', parentId: 'native-root', index: 0,
      title: expected.title, url: expected.url });

    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();

    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-inflight'))?.colpId, event.effect.node.id);
    assert.equal(await fixture.store.getMappingByColpId(scope, `pending-${event.operation.opId}`), null);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
  });

  test('rebinds an unsettled own-create echo during browser-call recovery without duplicating', async () => {
    // Same race, but the worker died mid-apply: resume() re-enters through the
    // uncertain-create recovery path instead of the ordinary commit path.
    const fixture = await setup('before_event'); const event: any = pullFixtures.createEvent({ kind: 'Bookmark',
      sequence: 62, collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId });
    const expected = event.effect.node as { title: string; url?: string };
    await fixture.store.putMapping(scope, { nativeId: 'native-inflight', colpId: `pending-${event.operation.opId}`,
      rootNativeId: 'native-root', nodeKind: 'bookmark', parentNativeId: 'native-root',
      projection: { revision: `local-${event.operation.opId}`, digest: 'sha256:inflight',
        content: { title: expected.title, url: expected.url ?? '' } } });
    fixture.api.seed({ id: 'native-inflight', parentId: 'native-root', index: 0,
      title: expected.title, url: expected.url });

    await fixture.applier.stage(fixture.page([event]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    fixture.disableCrash(); await createPullApplier(fixture.options).resume();

    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-inflight'))?.colpId, event.effect.node.id);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
  });

  test('preserves a later local projection when its authoritative self-create echo arrives', async () => {
    const fixture = await setup(); const event: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId });
    const create = await fixture.store.allocateSequenceAndEnqueue(scope, { opId: event.operation.opId,
      batchId: 'batch-create', idempotencyKey: 'key-create', digest: 'sha256:create', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'revision-create', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node' } }, { allowUnstamped: true });
    await fixture.store.completeQueueWithReceipt(scope, create.sequence, { opId: create.opId,
      operationDigest: create.digest, kind: 'terminal', receiptId: 'receipt-create', resultDigest: 'sha256:create-result' });
    await fixture.store.putMapping(scope, { ...fixture.mapping('native-self', event.effect.node.id, 'native-root'),
      projection: { revision: 'local-update', resourceRevision: 'local-update', childrenRevision: null,
        digest: 'sha256:local-update', content: { title: 'Advanced locally', url: 'https://example.test/' } } });
    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'later-update', batchId: 'batch-update',
      idempotencyKey: 'key-update', digest: 'sha256:update', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'revision-create', operationRevision: 'local-update', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: event.effect.node.id } }, { allowUnstamped: true });
    fixture.api.seed({ id: 'native-self', parentId: 'native-root', index: 0, title: 'Advanced locally',
      url: 'https://example.test/' });
    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-self'))?.projection.revision, 'local-update');
  });

  test.each(['update', 'move', 'delete'] as const)('applies remote %s idempotently and consumes delayed duplicate events', async (kind) => {
    const fixture = await setup(); const event = fixture.mutationEvent(kind); await fixture.applier.stage(fixture.page([event]));
    await fixture.applier.resume(); await fixture.applier.resume();
    assert.equal(await fixture.applier.observe(fixture.api.lastEvent!), true);
    assert.equal(await fixture.applier.observe(fixture.api.lastEvent!), true);
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
    assert.equal(fixture.api.calls.filter((call) => call.kind === kind).length, 1);
  });

  test.each(['update', 'move', 'delete'] as const)('applies remote %s to a separator sidecar without Chrome mutation', async (kind) => {
    const fixture = await setup(undefined, true);
    await fixture.store.putMapping(scope, { ...fixture.mapping('sidecar:node-1', 'node-1', 'native-root'),
      nodeKind: 'separator', projection: { revision: 'revision-old', resourceRevision: 'revision-old',
        childrenRevision: null, digest: 'sha256:sidecar', content: {} } });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent(kind)])); await fixture.applier.resume();
    assert.equal(fixture.api.calls.length, 0);
    assert.equal((await fixture.store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
  });

  test('places a remote create before its mapped native anchor', async () => {
    const fixture = await setup();
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: 'root-colp', beforeId: 'node-1' });
    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();
    const created = (await fixture.api.getChildren('native-root')).find((node) => node.id.startsWith('created-'));
    assert.equal(created?.index, 0);
  });

  test('fails closed when an after-anchor belongs to another native parent', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, fixture.mapping('native-node', 'node-1', 'native-other'));
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: 'root-colp', afterId: 'node-1' });
    await assert.rejects(() => fixture.applier.stage(fixture.page([event])), /anchor_parent_mismatch/);
  });

  test('fails closed when a mapped after-anchor disappeared from Chrome', async () => {
    const fixture = await setup(); await fixture.api.remove('native-node');
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: 'root-colp', afterId: 'node-1' });
    await fixture.applier.stage(fixture.page([event]));
    await assert.rejects(() => fixture.applier.resume(), /anchor_mapping_missing/);
  });

  test('advances canonical root content without renaming the selected native mount folder', async () => {
    const fixture = await setup();
    fixture.api.seed({ id: 'native-root', index: 0, title: 'Know-N' });
    const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 1,
      collectionId: scope.collectionId, targetId: 'root-colp', parentId: 'root-colp', targetKind: 'folder' });

    await fixture.applier.stage(fixture.page([event]));
    await fixture.applier.resume();

    assert.equal(fixture.api.calls.some((call) => call.kind === 'update' && call.nativeId === 'native-root'), false);
    assert.equal((await fixture.api.get('native-root'))[0]?.title, 'Know-N');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'root-colp'))?.projection.content?.title,
      'Remote update');
  });

  test('renames an unselected ordinary folder when canonical content advances', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, { ...fixture.mapping('native-node', 'node-1', 'native-root'),
      nodeKind: 'folder', projection: { revision: 'revision-old', resourceRevision: 'revision-old',
        childrenRevision: 'children-node', digest: 'sha256:old-folder', content: { title: 'Local folder' } } });
    fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Local folder' });
    const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 1,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp', targetKind: 'folder' });

    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();

    assert.equal(fixture.api.calls.some((call) => call.kind === 'update' && call.nativeId === 'native-node'), true);
    assert.equal((await fixture.api.get('native-node'))[0]?.title, 'Remote update');
  });

  test('consumes a terminal self-delete echo after the local delete already removed its mapping', async () => {
    const fixture = await setup(undefined, true); const event: any = pullFixtures.mutationEvent({ kind: 'delete', sequence: 1,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp', replicaId: scope.replicaId });
    const queued = await fixture.store.allocateSequenceAndEnqueue(scope, { opId: event.operation.opId,
      batchId: 'batch-self-delete', idempotencyKey: 'key-self-delete', digest: 'sha256:self-delete',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-old',
      operationRevision: 'delete-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'delete_node', targetId: 'node-1' } }, { allowUnstamped: true });
    await fixture.store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-self-delete',
      resultDigest: 'sha256:self-delete-result' });

    await fixture.applier.stage(fixture.page([event])); await fixture.applier.resume();

    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullPages[0]?.state, 'page_complete'); assert.equal(exported.cursor?.cursor, 'cursor-next');
  });

  test('consumes duplicate native evidence delivered out of order after page completion', async () => {
    const fixture = await setup(); await fixture.applier.stage(fixture.page([
      fixture.mutationEvent('update'), fixture.mutationEvent('move')])); await fixture.applier.resume();
    const intents = (await fixture.store.exportScope(scope)).intents;
    for (const intent of [...intents].reverse()) {
      assert.equal(await fixture.store.observeApplyIntentEvent(scope, intent.correlationId,
        { eventDigest: intent.correlationId }), true);
      assert.equal(await fixture.store.observeApplyIntentEvent(scope, intent.correlationId,
        { eventDigest: intent.correlationId }), true);
    }
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
  });

  test('a mounted recovery parent uses one native identity for intent, create and crash recovery', async () => {
    const fixture = await setup('after_browser_call', true);
    await fixture.store.deleteMapping(scope, 'native-root');
    await fixture.store.putMapping(scope, fixture.mapping('recovery:root-colp', 'root-colp'));
    await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
      remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false,
      status: 'active', rootRole: 'bookmarks-bar' });
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const created = (await fixture.api.getChildren('native-root'))[0]!;
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.intents[0]?.nativeParentId, 'native-root');
    const queue = createBookmarkEventQueue({ scope, store: fixture.store,
      api: { get: async (id) => (await fixture.api.get(id)).map((node) => ({ ...node, title: node.title ?? '' })),
        getChildren: async (id) => (await fixture.api.getChildren(id)).map((node) => ({ ...node, title: node.title ?? '' })) },
      autoFlush: false });
    const captured = await queue.created(created.id, { id: created.id, parentId: 'native-root', index: 0,
      title: 'Remote', url: 'https://example.test/' });
    assert.equal(captured.outcome, 'apply_intent_reserved');
    fixture.disableCrash(); fixture.store.close();
    await createPullApplier(fixture.options).resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 1);
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-1'))?.parentNativeId, 'native-root');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'root-colp'))?.nativeId, 'recovery:root-colp');
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('the create echo is swallowed by parent and content even when the native index drifted', async () => {
    // The worker dies right after chrome.bookmarks.create succeeded; the
    // onCreated callback then reaches the capture queue with an index that a
    // concurrent local insertion has shifted. Index-based correlation used to
    // miss here, capture the echo as a user create, and push a duplicate of
    // our own apply back to the server.
    const fixture = await setup('after_browser_call');
    const event: any = fixture.createEvent('Bookmark');
    await fixture.applier.stage(fixture.page([event]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const created = (await fixture.api.getChildren('native-root')).find((node) => node.id.startsWith('created-'))!;
    const queue = createBookmarkEventQueue({ scope, store: fixture.store,
      api: { get: (id) => fixture.api.get(id), getChildren: (id) => fixture.api.getChildren(id) } as BookmarkEventApi,
      autoFlush: false });

    const echo = await queue.created(created.id, { id: created.id, parentId: 'native-root', index: 7,
      title: 'Remote', url: 'https://example.test/' });
    assert.equal(echo.outcome, 'apply_intent_reserved');

    // A genuinely different user create in the same folder still stages.
    const user = await queue.created('user-new', { id: 'user-new', parentId: 'native-root', index: 3,
      title: 'User bookmark', url: 'https://example.test/user' });
    assert.equal(user.outcome, 'staged');
  });

  test('observe create falls back to the node-only correlation', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    await fixture.applier.resume();
    const created = fixture.api.lastEvent!;
    assert.equal(await fixture.applier.observe(created), true);
    assert.equal(await fixture.applier.observe({
      kind: 'create', nativeId: created.nativeId,
      details: { extra: true, node: created.details.node },
    }), false);
    assert.equal(await fixture.applier.observe({
      kind: 'create', nativeId: created.nativeId, details: { title: 'not-a-node' },
    }), false);
  });

  test('does not swallow a similar user event and leaves it available to the durable P3-30 queue', async () => {
    const fixture = await setup('before_event'); await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const similarUserEvent = { kind: 'change' as const, nativeId: 'native-node', details: { title: 'user edit' } };
    assert.equal(await fixture.applier.observe(similarUserEvent), false);
    assert.equal((await fixture.store.exportScope(scope)).intents[0]?.state, 'browser_call_started');
  });

  test('does not overwrite a durable later local edit while recovering an uncertain Pull update', async () => {
    const fixture = await setup('after_browser_call'); const event = fixture.mutationEvent('update');
    await fixture.applier.stage(fixture.page([event]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);

    await fixture.store.putMapping(scope, { ...fixture.mapping('native-node', 'node-1', 'native-root'),
      projection: { revision: 'local-later', resourceRevision: 'local-later', childrenRevision: null,
        digest: 'sha256:local-later', content: { title: 'Later local edit', url: 'https://example.test/' } } });
    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'later-local-update', batchId: 'batch-later',
      idempotencyKey: 'key-later', digest: 'sha256:later', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'revision-old', operationRevision: 'local-later', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'Remote update' }, value: { title: 'Later local edit' } } } }, { allowUnstamped: true });
    fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Later local edit',
      url: 'https://example.test/' });

    fixture.disableCrash(); await createPullApplier(fixture.options).resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'update').length, 1);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-node'))?.projection.revision, 'local-later');
  });

  test('preserves an existing durable local edit while applying an earlier remote Pull update', async () => {
    const fixture = await setup();
    const localContent = { title: 'Local pending', url: 'https://example.test/' };
    const localDigest = 'sha256:3529bfbf4a1b69e590041d8ca1fbc56a8c7671ee36ebb1781b3d7254c76f5e3a';
    await fixture.store.putMapping(scope, { ...fixture.mapping('native-node', 'node-1', 'native-root'),
      projection: { revision: 'authority-rebound', resourceRevision: 'authority-rebound', childrenRevision: null,
        digest: localDigest, content: localContent } });
    const queued = await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'local-pending-update',
      batchId: 'batch-local-pending', idempotencyKey: 'key-local-pending', digest: 'sha256:local-pending', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'revision-old', operationRevision: 'local-pending', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'node-1', url: 'https://example.test/' }, value: localContent } } }, { allowUnstamped: true });
    await fixture.store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-local-pending',
      resultDigest: 'sha256:local-pending-result' });
    fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Local pending',
      url: 'https://example.test/' });

    await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')]));
    await fixture.applier.resume();

    assert.equal(fixture.api.calls.filter((call) => call.kind === 'update').length, 0);
    assert.equal((await fixture.api.get('native-node'))[0]?.title, 'Local pending');
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-node'))?.projection.revision, 'authority-rebound');
  });

  test.each(['invalid_effect', 'tampered_digest', 'wrong_source', 'missing_effect_page'] as const)(
    'fails closed on %s with zero Chrome, queue and cursor effects', async (fault) => {
      const fixture = await setup(); const page = fixture.corrupt(fixture.page([fixture.createEvent('Bookmark')]), fault);
      await assert.rejects(() => fixture.applier.stage(page));
      const exported = await fixture.store.exportScope(scope);
      assert.equal(fixture.api.calls.length, 0); assert.equal(exported.queue.length, 0);
      assert.equal(exported.pullPages.length, 0); assert.equal(exported.scope?.checkpoint?.cursor, 'cursor-old');
    });

  test('keeps the intent and cursor durable when the browser API fails', async () => {
    const fixture = await setup(); await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    (fixture.api as any).create = async () => { throw new Error('browser_api_failed'); };
    await assert.rejects(() => fixture.applier.resume(), /browser_api_failed/);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.checkpoint?.cursor, 'cursor-old'); assert.equal(exported.queue.length, 0);
    assert.equal(exported.intents[0]?.state, 'browser_call_started');
  });

  test.each(['before_intent', 'after_intent', 'after_browser_call', 'after_api_evidence', 'before_event', 'after_event'] as const)(
    'recovers fail closed after %s worker crash', async (boundary) => {
      const fixture = await setup(boundary); await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
      await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
      fixture.store.close(); fixture.disableCrash();
      await createPullApplier(fixture.options).resume().catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'recovery_required') throw error;
      });
      const exported = await fixture.store.exportScope(scope);
      assert.ok(exported.cursor?.cursor === 'cursor-next' || exported.scope?.lifecycle === 'recovery_required');
      assert.ok(fixture.api.calls.filter((call) => call.kind === 'create').length <= 1);
    });

  test('applies inline and paged subtree deletion exactly, and blocks missing mappings', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.subtreeEvent(false)])); await fixture.applier.resume();
    const deleted = fixture.api.calls.filter((call) => call.kind === 'delete').map((call) => call.nativeId);
    assert.ok(deleted.includes('native-child') && deleted.includes('native-node'));
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-child'), null);
    indexedDB = new IDBFactory(); const paged = await setup();
    await paged.applier.stage(paged.page([paged.subtreeEvent(true)])); await paged.applier.resume();
    assert.equal((await paged.store.exportScope(scope)).effectPages.length, 1);
    assert.equal(await paged.store.getMappingByNativeId(scope, 'native-child'), null);
    indexedDB = new IDBFactory();
    const missing = await setup(undefined, true);
    await assert.rejects(() => missing.applier.stage(missing.page([missing.subtreeEvent(true)])), /mapping_missing/);
  });
});

test('REVIEW: a native edit missed by capture survives a remote update and reconciliation', async () => {
  const fixture = await setup();
  const savedUrl = 'https://local-only.example/never-uploaded';
  // Chrome has durably saved this edit, but capture failed or was frozen.
  fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0,
    title: 'User saved', url: savedUrl });
  await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')]));
  await fixture.applier.resume();
  const queue = createBookmarkEventQueue({ scope, store: fixture.store,
    api: { get: async (id) => (await fixture.api.get(id)).map((node) => ({ ...node, title: node.title ?? '' })),
      getChildren: async (id) => (await fixture.api.getChildren(id)).map((node) => ({ ...node, title: node.title ?? '' })) } });
  await queue.recover();
  const persisted = JSON.stringify(await fixture.store.exportScope(scope));
  const native = await fixture.api.get('native-node');
  assert.ok(native.some(node => node.url === savedUrl) || persisted.includes(savedUrl),
    'the locally saved URL must survive in Chrome or durable recovery evidence');
});

test('REVIEW: an earlier self update echo preserves a later durable local edit', async () => {
  const fixture = await setup();
  // Chrome already matches the earlier echo; the later edit exists only in the queue.
  fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0,
    title: 'Remote update', url: 'https://example.test/' });
  await fixture.store.allocateSequenceAndEnqueue(scope, {
    opId: 'later-local-update', batchId: 'batch-later', idempotencyKey: 'key-later',
    digest: 'sha256:later', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-old', operationRevision: 'local-later', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
      payload: { base: { title: 'node-1' }, value: { title: 'Later local edit' } } },
  }, { allowUnstamped: true });
  const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 1,
    collectionId: scope.collectionId, replicaId: scope.replicaId, targetId: 'node-1', parentId: 'root-colp' });
  await fixture.applier.stage(fixture.page([event]));
  await fixture.applier.resume();
  assert.equal((await fixture.api.get('native-node'))[0]?.title, 'Later local edit');
});

async function setup(crash?: string, omitNodeMappings = false) {
  const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-pull', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready' });
  const mapping = (nativeId: string, colpId: string, parentNativeId?: string) => ({ nativeId, colpId,
    rootNativeId: 'native-root', nodeKind: colpId === 'root-colp' ? 'folder' as const : 'bookmark' as const,
    ...(parentNativeId ? { parentNativeId } : {}), projection: { revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: colpId === 'root-colp' ? 'children-old' : null, digest: `sha256:${colpId}`,
      content: { title: colpId, url: 'https://example.test/' } } });
  await store.putMapping(scope, mapping('native-root', 'root-colp'));
  if (!omitNodeMappings) { await store.putMapping(scope, mapping('native-node', 'node-1', 'native-root'));
    await store.putMapping(scope, mapping('native-child', 'node-child', 'native-node')); }
  // B3-1: the device double is the shared honest one. `node-1` is declared a bookmark, so it must
  // be a Chrome leaf - seeding `native-child` under it was only representable by a lenient
  // `remove`, and the SR-02 anchor test below needs a real `Can't find bookmark for id.` rejection.
  const api = honestChrome(); api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  if (!omitNodeMappings) { api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1',
    url: 'https://example.test/' }); api.seed({ id: 'native-child', parentId: 'native-root', index: 1,
    title: 'node-child', url: 'https://example.test/' }); }
  let crashBoundary = crash;
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-pull',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', crash: (at: string) => {
      if (crashBoundary === at) { crashBoundary = undefined; throw new Error('worker_crash'); }
    } };
  const applier = createPullApplier(options);
  let ordinal = 0;
  const createEvent = (kind: 'Folder' | 'Bookmark' | 'Separator', sequence = ++ordinal, afterId?: string) =>
    pullFixtures.createEvent({ kind, sequence, collectionId: scope.collectionId, parentId: 'root-colp', afterId });
  const mutationEvent = (kind: 'update' | 'move' | 'delete') => pullFixtures.mutationEvent({ kind,
    sequence: ++ordinal, collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' });
  const subtreeEvent = (paged: boolean) => pullFixtures.subtreeEvent({ sequence: ++ordinal,
    collectionId: scope.collectionId, targetId: 'node-1', members: ['node-1', 'node-child'], paged });
  const page = (events: readonly unknown[]) => pullFixtures.page({ events, nextCursor: 'cursor-next',
    collectionRevision: 'revision-next' });
  return { store, api, options, applier, mapping, createEvent, mutationEvent, subtreeEvent, page,
    corrupt: pullFixtures.corrupt, disableCrash: () => { crashBoundary = undefined; } };
}

for (const boundary of ['login', 'logout', 'collection'] as const) test(`live Pull capability fences ${boundary} before native dispatch`, async () => {
  const f = await setup(); const fence = createAuthorityFence(new MemoryStorageArea());
  let current = scope;
  const effects = createSyncEffectAuthority({ scope, context: await fence.capture(), api: f.api,
    assertWritable: generation => fence.assertWritable(generation), currentScope: async () => current });
  const applier = createPullApplier({ ...f.options, api: effects.api, assertCurrent: effects.assertCurrent });
  const page = f.page([f.createEvent('Bookmark')]);
  await applier.stage(page);
  if (boundary === 'login') await fence.activate();
  if (boundary === 'logout') await fence.revoke();
  if (boundary === 'collection') current = { ...scope, collectionId: 'other' };
  await assert.rejects(applier.resume, /authority_fenced/);
  await assert.rejects(() => applier.stage(page), /authority_fenced/);
  for (const effect of [() => effects.api.create({ title: 'late' }), () => effects.api.update('native-node', { title: 'late' }),
    () => effects.api.remove('native-node'), () => effects.api.removeTree('native-root')]) await assert.rejects(effect, /authority_fenced/);
  assert.equal(f.api.calls.length, 0);
  assert.equal((await f.store.exportScope(scope)).cursor?.cursor, undefined);
});
