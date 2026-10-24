/**
 * B-16: applying a Pull page used to list every mapping of the library twice and every mapping and every intent twice
 * more for each remote create (the issue check in `setAsidePullItem`, and the occupancy map of `executeNativeCreate`
 * before and after Chrome's call), so a first sync of a large library read O(N^2) rows. A create that nothing holds
 * back now reads no list at all; a map of every claim is built only on the paths that compare more than one id.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { collectNativeOccupancy, executeNativeCreate, nativeOccupant } from '../src/native-create-executor.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../src/recovery-overlay.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

type Fixture = Awaited<ReturnType<typeof setup>>;
const WHOLE_LIBRARY_READS = ['listMappings', 'listApplyIntents'];

/** The store, counting the calls that read every row of the library; everything else is the real thing. */
function counting(store: Fixture['store']) {
  const calls: Record<string, number> = {};
  const wrapped = Object.fromEntries(Object.entries(store).map(([name, value]) => {
    if (typeof value !== 'function' || !WHOLE_LIBRARY_READS.includes(name)) return [name, value];
    return [name, (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return (value as (...rest: unknown[]) => unknown).apply(store, args);
    }];
  })) as unknown as Fixture['store'];
  return { wrapped, calls, total: () => Object.values(calls).reduce((sum, count) => sum + count, 0) };
}

describe('a Pull page of remote creates', () => {
  test('lists no mapping and no intent per event, however many events the page carries', async () => {
    const fixture = await setup();
    const reads = counting(fixture.store);
    const applier = createPullApplier({ ...fixture.options, store: reads.wrapped });
    let sequence = 100;
    const pageOf = (count: number, label: string) => Array.from({ length: count }, () => {
      sequence += 1;
      return pullFixtures.createEvent({ kind: 'Bookmark', sequence, collectionId: scope.collectionId, parentId: 'root-colp',
        title: `${label} ${sequence}`, url: `https://example.test/${label}/${sequence}` });
    });
    const applied: string[] = [];
    const apply = async (events: ReturnType<typeof pageOf>, cursor: string) => {
      const before = reads.total();
      await applier.stage(fixture.page(events, cursor));
      await applier.resume();
      for (const event of events) applied.push((event as { effect: { node: { id: string } } }).effect.node.id);
      return reads.total() - before;
    };
    const small = await apply(pageOf(8, 'small'), 'cursor-small');
    const large = await apply(pageOf(40, 'large'), 'cursor-large');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 48, 'every create reached Chrome');
    for (const colpId of applied) assert.ok(await fixture.store.getMappingByColpId(scope, colpId), `${colpId} is mapped`);
    assert.ok(large <= small, `a page of 40 creates read the whole library ${large} times, a page of 8 read it ${small} times`);
    assert.deepEqual(reads.calls, {}, 'no create listed every mapping or every intent');
    fixture.store.close();
  });
});

describe('who owns the native id Chrome answered a create with', () => {
  const stubApi = { getChildren: async () => [] } as unknown as PullBookmarkApi;
  const owner = (colpId: string) => ({ scopeKey: scopeKey(scope), generation: 1, commandId: 'pull',
    eventId: `event-${colpId}`, colpId, substep: 'create' });
  const projectionIntent = (colpId: string, order: number, extra: Partial<ProjectionIntentRecord>): ProjectionIntentRecord => ({
    intentId: `create:${colpId}`, kind: 'create', colpId, order, generation: 1,
    suppression: createProjectionSuppression('native-root', 'Held', 'https://example.test/held'),
    parentColpId: 'root-colp', parentNativeId: 'native-root', title: 'Held', url: 'https://example.test/held',
    folder: false, state: 'executing', ...extra });

  /** One library where every source of a claim holds one id of its own. */
  async function library() {
    const fixture = await setup(undefined, true);
    const { store } = fixture;
    await store.putMapping(scope, mappingInput('chrome-mapped', 'colp-mapped'));
    await store.putLocalSyncExclusion(scope, { nativeId: 'chrome-excluded', decisionId: 'keep:chrome-excluded',
      rootNativeId: 'native-root', generation: scope.generation, sourceKind: 'remote_delete', priorColpId: 'colp-excluded' });
    await store.replaceProjectionIntents(scope, [
      projectionIntent('colp-projected', 1, { observedNativeId: 'chrome-projected' }),
      projectionIntent('colp-finished', 2, { observedNativeId: 'chrome-finished', state: 'terminal' })]);
    const intent = async (colpId: string, answer: string, facts: Parameters<typeof store.persistApplyIntentFacts>[2]) => {
      await store.createApplyIntent(scope, { intentId: `intent-${colpId}`, correlationId: `corr-${colpId}`,
        operationId: `op-${colpId}`, expected: { kind: 'create', nativeId: `pending:${colpId}` }, expiresAt: Date.now() + 300_000,
        state: 'intent_prepared', generation: 1, commandId: 'pull', colpId, substep: 'create', liveWorkKind: 'create',
        nativeParentId: 'native-root', nativeResult: 'not_started', replayState: 'not_started' });
      await store.persistApplyIntentFacts(scope, `intent-${colpId}`, { apiResultEvidence: { operationId: `op-${colpId}`, nativeId: answer },
        nativeResultConfirmation: { kind: 'api_return', nativeId: answer }, ...facts });
    };
    // A create whose answer was kept but never mapped: parked for the user.
    await intent('colp-parked', 'chrome-parked', { nativeResult: 'result_unknown', waitReason: 'native_result_unknown',
      replayState: 'awaiting_receipt' });
    // A create that finished: its answer is in its mapping, or the bookmark is gone.
    await intent('colp-settled', 'chrome-settled', { nativeResult: 'applied_with_evidence', state: 'page_complete',
      replayState: 'committed' });
    const create = (colpId: string, answer: string) => executeNativeCreate({ scope, store, api: stubApi,
      intentId: `create-${colpId}`, owner: owner(colpId), parentNativeId: 'native-root', expected: { title: colpId },
      create: async () => ({ id: answer }) });
    return { fixture, store, create };
  }

  const HELD = ['chrome-mapped', 'chrome-projected'];

  test.each(HELD)('%s belongs to another bookmark: the create waits for the user instead of claiming it', async (answer) => {
    const { fixture, create } = await library();
    const outcome = await create('colp-new', answer);
    assert.equal(outcome.result, 'result_unknown');
    fixture.store.close();
  });

  test('an id nobody holds, or only a finished projection or a virtual id names, is the new bookmark', async () => {
    const { fixture, create } = await library();
    assert.deepEqual(await create('colp-a', 'chrome-free'), { result: 'applied_with_evidence', nativeId: 'chrome-free' });
    assert.deepEqual(await create('colp-b', 'chrome-finished'), { result: 'applied_with_evidence', nativeId: 'chrome-finished' });
    assert.deepEqual(await create('colp-c', 'pending-colp-c'), { result: 'applied_with_evidence', nativeId: 'pending-colp-c' });
    fixture.store.close();
  });

  // Unchanged: the intent written for this very create records the answer under its own colpId before the check, and
  // that claim beats an exclusion and (by the order of the intents' keys) a parked or finished intent of another node.
  test.each(['chrome-excluded', 'chrome-parked', 'chrome-settled'])('%s is not held back by an exclusion or an intent of another bookmark', async (answer) => {
    const { fixture, create } = await library();
    assert.deepEqual(await create('colp-new', answer), { result: 'applied_with_evidence', nativeId: answer });
    fixture.store.close();
  });

  test('the single lookup names the same owner as the map of every claim wherever it can name one', async () => {
    const { fixture, store } = await library();
    const everything = await collectNativeOccupancy(store, scope);
    for (const id of [...HELD, 'chrome-free', 'chrome-finished', 'pending-colp-c', 'recovery:colp-x']) {
      assert.equal(await nativeOccupant(store, scope, id), everything.get(id), id);
    }
    assert.equal(await nativeOccupant(store, scope, 'chrome-mapped'), 'colp-mapped');
    assert.equal(await nativeOccupant(store, scope, 'chrome-projected'), 'colp-projected');
    // The map of every claim also lists exclusions and intents; the lookup after Chrome's call does not (see above).
    const listedOnly: ReadonlyArray<readonly [string, string]> = [['chrome-excluded', 'colp-excluded'],
      ['chrome-parked', 'colp-parked'], ['chrome-settled', 'colp-settled']];
    for (const [id, owner] of listedOnly) {
      assert.equal(everything.get(id), owner);
      assert.equal(await nativeOccupant(store, scope, id), undefined);
    }
    fixture.store.close();
  });
});
