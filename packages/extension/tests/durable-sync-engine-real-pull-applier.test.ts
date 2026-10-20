/**
 * A-12 / SR-16: the durable engine harness and the real Pull applier.
 *
 * The audit claim (`synthesis.md` §1.2) was that the harness's hand-written `pullApplier` always
 * staged `events: []`, so every engine case silently ran the "empty page Ack" path and never
 * touched page validation, cursor-chain admission, event application or crash recovery.
 *
 * Main remediation attempted and measured: making `createPullApplier` the harness *default*. The
 * real applier admits an Ack-only page only when its cursor identity is unchanged or the response
 * carries `Known-Sync-Cursor-Reissued: true` (`src/pull-page-stager.ts` `pull_cursor_chain_invalid`),
 * while all 67 engine-harness Pull fixtures advance the cursor with an empty page: the default made
 * 69 of 200 consumer tests fail across 9 files, including two files this lane must not edit. The
 * accepted fallback (`solution.md` §S8 / `acceptance.md` A-12) is therefore:
 *
 *   1. the production `recoverVerifiedOrFreeze` projector is the harness default, and the old
 *      synthetic projector is reachable only through the explicitly named `useStandInProjector`;
 *   2. the Ack-only (empty) page is named at every call site (`emptyPullPage`) and keeps its own
 *      named coverage here - it is no longer an unnamed default shape;
 *   3. the real applier is reachable through `setup({ useRealPullApplier: true })`, and this file
 *      proves it applies and persists a real event page end-to-end through the engine.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import {
  ack, emptyPullPage, json, pullEventsPage, scope, setup,
} from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/** A remote create under the fixture's `root-old` mapping (native `native-root`). */
function remoteCreateBookmark() {
  return pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: 'root-old' });
}

describe('A-12/SR-16 durable engine harness over the real Pull applier', () => {
  test('the real createPullApplier applies an event-carrying Pull page and persists it', async () => {
    const fixture = await setup({ useRealPullApplier: true, confirmedMount: true });
    fixture.pullResponses.push(json(200, pullEventsPage([remoteCreateBookmark()], 'cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    // The engine drove the production applier through its own stage/resume seam.
    assert.deepEqual(fixture.order, ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    // The event landed in Chrome under the parent mapping's native id...
    assert.deepEqual(fixture.chromeNodes.get('2'), { id: '2', parentId: 'native-root', index: 0,
      title: 'Remote', url: 'https://example.test/' });
    // ...and its mapping, the committed event and the completed page are durable facts. None of
    // this could happen through the removed double, which always staged `events: []`.
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-1'))?.nativeId, '2');
    const committed = (await fixture.store.listPullEvents(scope))[0]!;
    assert.equal(committed.state, 'page_complete');
    assert.equal((committed.pendingMappings as Array<{ readonly nativeId: string }>)[0]?.nativeId, '2');
    assert.equal((await fixture.store.listPullPages(scope))[0]?.state, 'page_complete');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-1');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
  });

  test('the Ack-only (empty) Pull page is an explicitly named case with its own coverage', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    // Ack-only means exactly that: a page with zero events is staged and completed so the cursor
    // can be published and acknowledged, and nothing else changes.
    assert.deepEqual(fixture.order, ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-1');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
    assert.equal((await fixture.store.listPullPages(scope))[0]?.eventCount, 0);
    assert.deepEqual(exported.pullEvents, []);
    assert.deepEqual([...fixture.chromeNodes.keys()], ['1']);
  });

  test('the default Ack-only applier refuses to swallow an event-carrying Pull page', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, pullEventsPage([remoteCreateBookmark()], 'cursor-1')));

    await fixture.engine.wake('manual');

    // A fixture that stages events must opt into the real applier; the default cannot quietly
    // drop them on the floor and still report a healthy Ack.
    assert.equal(await fixture.store.getMappingByColpId(scope, 'node-created-1'), null);
    const exported = await fixture.store.exportScope(scope);
    assert.deepEqual(exported.pullEvents, []);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, undefined);
    assert.equal(exported.engine.lastError, 'ack_only_pull_applier_cannot_apply_events');
  });

  test('the real applier accepts the Ack-only page when the cursor identity is reissued', async () => {
    const fixture = await setup({ useRealPullApplier: true });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'),
      { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    // This is the shape the engine harness fixtures would have to serve if the real applier were
    // the default: an Ack-only page may re-derive the cursor only with the reissue marker.
    assert.deepEqual(fixture.pullCursorAuthorities, [{ reissued: true }]);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-1');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
    assert.deepEqual(exported.pullEvents, []);
    assert.equal((await fixture.store.listPullPages(scope))[0]?.state, 'page_complete');
  });

  test('the real applier names the empty-advancing-cursor refusal that blocks the default wiring', async () => {
    const fixture = await setup({ useRealPullApplier: true });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));

    await fixture.engine.wake('manual');

    // Root cause of the measured fallback: `pull-page-stager.ts` refuses an event-less page whose
    // cursor moved without `Known-Sync-Cursor-Reissued`, and freezes the scope instead of
    // publishing an Ack the server never evidenced.
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.lastError, 'pull_cursor_chain_invalid');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, undefined);
  });
});
