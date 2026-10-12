import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ack, json, problem, recoverySnapshot, scope, setup, snapshot,
} from './durable-sync-engine-harness.js';
import { SNAPSHOT_MATERIALIZATION_EXTENSION } from '../src/snapshot-v02-consume.js';
import { SNAPSHOT_MATERIALIZATION_SORT_VERSION } from '../src/snapshot-v02-pages.js';

function parentFirstSnapshot(sequence: number, hasMore: boolean, nextCursor: string | null, snapshotId = 'snapshot-new') {
  const page = snapshot(sequence, hasMore, nextCursor) as ReturnType<typeof snapshot> & {
    snapshotId: string;
    collection: { extensions: Record<string, unknown> };
  };
  return {
    ...page,
    snapshotId,
    collection: {
      ...page.collection,
      extensions: {
        ...page.collection.extensions,
        [SNAPSHOT_MATERIALIZATION_EXTENSION]: { sortAlgorithm: SNAPSHOT_MATERIALIZATION_SORT_VERSION },
      },
    },
  };
}

describe('T-04 Snapshot recovery identity and paging', () => {
  test('S-05 interrupt before/after each page, Snapshot expiry, Session refresh', async () => {
    // Subject is the crash/interrupt paging mechanics plus Session refresh. These fixtures
    // seed no Chrome world, so the production identity projector would freeze instead of
    // completing recovery; the stand-in this suite used implicitly is now named.
    const before = await setup({ snapshotRequired: true, useStandInProjector: true });
    before.crashAt = 'before_snapshot_page';
    before.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    await assert.rejects(() => before.engine.wake('startup'), /worker_crash/);
    assert.equal((await before.store.exportScope(scope)).recovery, null);

    const after = await setup({ snapshotRequired: true, useStandInProjector: true });
    after.crashAt = 'after_snapshot_page';
    after.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      json(200, recoverySnapshot(2, false, null)));
    after.ackResponses.push(json(200, ack('bootstrap-cursor')));
    after.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await assert.rejects(() => after.engine.wake('startup'), /worker_crash/);
    const staged = await after.store.exportScope(scope);
    assert.equal(staged.recovery?.lastPage, 0);
    after.store.close();
    await after.reopen().wake('startup');
    assert.equal((await after.store.exportScope(scope)).engine.recoveryFrozen, false);

    const expired = await setup({ snapshotRequired: true, useStandInProjector: true });
    expired.snapshotResponses.push(problem(410, 'snapshot_expired', {}));
    await expired.engine.wake('startup');
    const expiredState = await expired.store.exportScope(scope);
    assert.equal(expiredState.engine.recoveryFrozen, true);
    assert.match(String(expiredState.engine.lastError), /snapshot_expired/);

    const refresh = await setup({ snapshotRequired: true, useStandInProjector: true });
    refresh.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    refresh.ackResponses.push(json(200, ack('bootstrap-cursor')));
    refresh.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await refresh.engine.wake('startup');
    assert.equal((await refresh.store.exportScope(scope)).engine.sessionId, 'session-renewed');
  });

  test('S-06 old staging upgrade replaces authority once and keeps all local pending edits', async () => {
    // Subject is the legacy-staging upgrade/cutover; the production identity projector would
    // refuse this pre-seeded recovery:root-server staging, so the stand-in is named explicitly.
    const fixture = await setup({ snapshotRequired: true, useStandInProjector: true });
    await fixture.enqueue('pending-local');
    await fixture.store.stageRecoveryPage(scope, {
      snapshotId: 'snapshot-old', revision: 'revision-snapshot', syncCursor: 'bootstrap-cursor',
      identityDigest: 'sha256:old', rootNodeId: 'root-server', page: 0, pageDigest: 'sha256:old-page',
      previousPageDigest: null, nextCursor: 'page-2', complete: false, sessionId: 'session-engine',
      materializationVersion: 'parent-id-v0',
      nodes: [{
        colpId: 'root-server', parentId: null, position: 'p0', kind: 'Folder', payloadDigest: 'sha256:root',
        mapping: {
          nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
          projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
            content: { title: '', folderRole: 'root' } },
        },
      }],
    });
    const next = parentFirstSnapshot(1, false, null, 'snapshot-new');
    fixture.snapshotResponses.push(json(200, next), json(200, next));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.recovery, null);
    assert.ok(exported.mappings.some((row: { colpId: string }) => row.colpId === 'root-server'));
    assert.equal(fixture.snapshotRequests.length, 2);
    assert.equal(new URL(fixture.snapshotRequests[1]!.url).searchParams.has('pageCursor'), false);
    const pending = await fixture.store.listQueue(scope, 'pending', 0, 10);
    assert.equal(pending.length >= 1, true);
  });

  test('S-07 two profiles with pending local ops recover the same Node identities', async () => {
    const page = parentFirstSnapshot(1, false, null);
    async function recoverProfile() {
      const fixture = await setup({ snapshotRequired: true, emptyCollection: true });
      await fixture.enqueue('local-edit');
      fixture.snapshotResponses.push(json(200, page));
      fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
      fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
      await fixture.engine.wake('startup');
      const exported = await fixture.store.exportScope(scope);
      return {
        colpIds: exported.mappings.map((row: { colpId: string }) => row.colpId).sort(),
        titles: exported.mappings.map((row: { projection?: { content?: { title?: string } } }) =>
          row.projection?.content?.title),
        queue: await fixture.store.listQueue(scope, 'pending', 0, 10),
      };
    }
    const first = await recoverProfile();
    const second = await recoverProfile();
    assert.deepEqual(first.colpIds, second.colpIds);
    assert.deepEqual(first.titles, second.titles);
    assert.ok(first.queue.length >= 1);
    assert.ok(second.queue.length >= 1);
  });
});
