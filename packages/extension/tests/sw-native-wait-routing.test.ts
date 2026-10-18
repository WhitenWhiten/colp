/**
 * S1 / B0-1 (SR-01): SW transport for the native-wait product exit.
 *
 * The durable half is driven through a real `createSyncStateStore` fixture that
 * reaches `nativeResult: 'result_unknown'` by actually crashing the pull applier
 * after the Chrome create (the T-02 shape), so the handler is exercised against
 * real intent/event facts instead of a hand-written fake.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { projectNativeWaits } from '../src/native-wait.js';
import { pendingNativeOrPullFacts, repairNativeSideEffects } from '../src/native-repair.js';
import { validNativeWaitRequest } from '../src/sw/messages.js';
import { handleNativeWaitRequest, type NativeWaitDeps } from '../src/sw/native-wait.js';
import type { IntentRecord } from '../src/sync-state-store.js';
import type { NativeWaitConfirmRequest } from '../src/types.js';
import { mapping, reopenT02, setupT02, t02Scope } from './srg-t02-native-harness.js';

type Fixture = Awaited<ReturnType<typeof unknownWait>>;

/** Crash the applier after the Chrome create so the durable intent is truly unknown. */
async function unknownWait(kind: 'Folder' | 'Bookmark' = 'Bookmark') {
  const fixture = await setupT02('after_create_before_evidence');
  await fixture.applier.stage(fixture.page([fixture.createEvent(kind)]));
  await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
  fixture.disableCrash();
  const resumed = await reopenT02(fixture);
  await resumed.applier.resume().catch((error: unknown) => {
    if (!(error instanceof Error) || !/native_result_unknown|recovery_required/u.test(error.message)) throw error;
  });
  const waits = await projectNativeWaits(resumed.store, t02Scope);
  assert.equal(waits.length, 1, 'fixture must leave exactly one pending wait');
  const wait = waits[0]!;
  const intent = await resumed.store.getApplyIntent(t02Scope, wait.intentId);
  assert.ok(intent, 'fixture intent must exist');
  return { ...resumed, wait, waitRef: wait.waitRef, intent };
}

function harness(fixture: { readonly store: Fixture['store']; readonly api: Fixture['api'] },
  overrides: Partial<NativeWaitDeps> = {}) {
  const wakes: number[] = [];
  const deps: NativeWaitDeps = {
    scope: async () => t02Scope,
    store: fixture.store,
    permissionGranted: async () => true,
    wake: () => { wakes.push(1); },
    api: () => fixture.api,
    ...overrides,
  };
  return { deps, wakes };
}

function confirmMessage(wait: Fixture['wait'], intent: IntentRecord, action: NativeWaitConfirmRequest['action'],
  nativeId?: string): NativeWaitConfirmRequest {
  return {
    kind: 'known.nativeWait.confirm', userGesture: true, waitRef: wait.waitRef, intentId: intent.intentId,
    generation: intent.generation ?? t02Scope.generation, action,
    ...(nativeId === undefined ? {} : { nativeId }),
  };
}

describe('validNativeWaitRequest whitelist', () => {
  test('accepts the list read and the three confirm actions', () => {
    assert.equal(validNativeWaitRequest({ kind: 'known.nativeWait.list' }), true);
    const base = {
      kind: 'known.nativeWait.confirm', userGesture: true, waitRef: 'nwr:intent:1:1', intentId: 'intent:1',
      generation: 1,
    };
    assert.equal(validNativeWaitRequest({ ...base, action: 'bind', nativeId: 'bm-1' }), true);
    assert.equal(validNativeWaitRequest({ ...base, action: 'keep_local_and_create' }), true);
    assert.equal(validNativeWaitRequest({ ...base, action: 'cancel' }), true);
  });

  test('rejects extra keys, arrays, bad ids, generations, actions and nativeId placement', () => {
    const base = {
      kind: 'known.nativeWait.confirm', userGesture: true, waitRef: 'nwr:intent:1:1', intentId: 'intent:1',
      generation: 1, action: 'cancel',
    };
    assert.equal(validNativeWaitRequest(null), false);
    assert.equal(validNativeWaitRequest('known.nativeWait.list'), false);
    assert.equal(validNativeWaitRequest([{ kind: 'known.nativeWait.list' }]), false);
    assert.equal(validNativeWaitRequest({}), false);
    assert.equal(validNativeWaitRequest({ kind: 'known.nativeWait.list', extra: 1 }), false);
    assert.equal(validNativeWaitRequest({ kind: 'known.nativeWait.confirm' }), false);
    assert.equal(validNativeWaitRequest({ ...base, userGesture: false }), false);
    assert.equal(validNativeWaitRequest({ ...base, userGesture: undefined }), false);
    assert.equal(validNativeWaitRequest({ ...base, waitRef: '' }), false);
    assert.equal(validNativeWaitRequest({ ...base, waitRef: 'a'.repeat(257) }), false);
    assert.equal(validNativeWaitRequest({ ...base, waitRef: 'nwr:\u0001' }), false);
    assert.equal(validNativeWaitRequest({ ...base, intentId: '' }), false);
    assert.equal(validNativeWaitRequest({ ...base, intentId: 'b'.repeat(257) }), false);
    assert.equal(validNativeWaitRequest({ ...base, generation: 0 }), false);
    assert.equal(validNativeWaitRequest({ ...base, generation: 1.5 }), false);
    assert.equal(validNativeWaitRequest({ ...base, generation: '1' }), false);
    assert.equal(validNativeWaitRequest({ ...base, generation: Number.MAX_SAFE_INTEGER + 1 }), false);
    assert.equal(validNativeWaitRequest({ ...base, action: 'apply' }), false);
    assert.equal(validNativeWaitRequest({ ...base, action: 'bind' }), false);
    assert.equal(validNativeWaitRequest({ ...base, action: 'bind', nativeId: '' }), false);
    assert.equal(validNativeWaitRequest({ ...base, action: 'bind', nativeId: 'c'.repeat(257) }), false);
    // `nativeId` is only meaningful for bind: the whitelist refuses it elsewhere
    // instead of silently ignoring an identity the action cannot use.
    assert.equal(validNativeWaitRequest({ ...base, nativeId: 'bm-1' }), false);
    assert.equal(validNativeWaitRequest({ ...base, action: 'keep_local_and_create', nativeId: 'bm-1' }), false);
    assert.equal(validNativeWaitRequest({ ...base, extra: 1 }), false);
  });
});

describe('handleNativeWaitRequest', () => {
  test('list projects the durable wait with its generation and no leaked internals', async () => {
    const fixture = await unknownWait();
    const { deps, wakes } = harness(fixture);
    const response = await handleNativeWaitRequest({ kind: 'known.nativeWait.list' }, deps);
    assert.equal(response.ok, true);
    if (response.ok !== true || !('waits' in response)) throw new Error('expected a list response');
    assert.equal(response.waits.length, 1);
    const wait = response.waits[0]!;
    assert.equal(wait.waitRef, fixture.waitRef);
    assert.equal(wait.intentId, fixture.intent.intentId);
    assert.equal(wait.colpId, 'node-created-1');
    assert.equal(wait.waitReason, 'native_result_unknown');
    assert.equal(wait.generation, t02Scope.generation);
    assert.deepEqual(wait.affectedRange, { parentNativeId: 'native-root' });
    // `persistUnknown` stores the wait ref without a candidate id, so the exit
    // must be drivable from a typed native id; candidates stay an honest list.
    assert.deepEqual(wait.candidates, []);
    assert.deepEqual(Object.keys(wait).sort(),
      ['affectedRange', 'candidates', 'colpId', 'generation', 'intentId', 'title', 'url', 'waitReason', 'waitRef']);
    assert.deepEqual(wakes, [], 'a read must not wake the engine');
  });

  test('bind claims the orphan native, settles the event and is durable against repair', async () => {
    const fixture = await unknownWait();
    const { deps, wakes } = harness(fixture);
    const orphan = fixture.api.all().find((node) => node.id.startsWith('created-'))!;
    const bound = await handleNativeWaitRequest(confirmMessage(fixture.wait, fixture.intent, 'bind', orphan.id), deps);
    assert.deepEqual(bound, { ok: true, result: 'bound', nativeId: orphan.id });
    assert.deepEqual(wakes, [1]);

    const intent = await fixture.store.getApplyIntent(t02Scope, fixture.intent.intentId);
    assert.equal(intent?.nativeResult, 'applied_with_evidence');
    assert.equal(intent?.replayState, 'awaiting_receipt');
    assert.equal(intent?.waitReason, undefined);
    assert.equal(intent?.nativeResultConfirmation?.kind, 'candidate_event');
    assert.equal(intent?.nativeResultConfirmation?.nativeId, orphan.id);
    assert.equal((await fixture.store.getMappingByColpId(t02Scope, 'node-created-1'))?.nativeId, orphan.id);
    const eventId = fixture.intent.eventId;
    assert.equal(typeof eventId, 'string');
    const event = await fixture.store.getPullEvent(t02Scope, String(eventId));
    assert.notEqual(String(event?.state), 'awaiting_confirmation');

    // A second confirm is an idempotent duplicate, not a second landing.
    const again = await handleNativeWaitRequest(confirmMessage(fixture.wait, fixture.intent, 'bind', orphan.id), deps);
    assert.deepEqual(again, { ok: true, result: 'duplicate', nativeId: orphan.id });

    // The confirmation is the receipt: the native repair pass must not re-open
    // the wait (which would re-park Ack with the same waitRef).
    await repairNativeSideEffects(fixture.store, t02Scope, fixture.api);
    const repaired = await fixture.store.getApplyIntent(t02Scope, fixture.intent.intentId);
    assert.equal(repaired?.nativeResult, 'applied_with_evidence');
    assert.equal(repaired?.waitReason, undefined);
    assert.equal((await fixture.store.listPullEvents(t02Scope, ['awaiting_confirmation'])).length, 0);
    assert.deepEqual(await projectNativeWaits(fixture.store, t02Scope), []);
  });

  test('keep_local_and_create lands the remote node under the intent parent', async () => {
    const fixture = await unknownWait();
    const { deps, wakes } = harness(fixture);
    const created: Array<{ parentId?: string; index?: number; title?: string; url?: string }> = [];
    const create = fixture.api.create.bind(fixture.api);
    fixture.api.create = async (input) => { created.push(input); return create(input); };
    const response = await handleNativeWaitRequest(
      confirmMessage(fixture.wait, fixture.intent, 'keep_local_and_create'), deps);
    assert.equal(response.ok, true);
    if (response.ok !== true || !('result' in response)) throw new Error('expected a confirm response');
    assert.equal(response.result, 'kept_local');
    assert.equal(typeof response.nativeId, 'string');
    assert.deepEqual(wakes, [1]);

    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/' });
    const mapping = await fixture.store.getMappingByColpId(t02Scope, 'node-created-1');
    assert.equal(mapping?.nativeId, response.nativeId);
    const intent = await fixture.store.getApplyIntent(t02Scope, fixture.intent.intentId);
    assert.equal(intent?.nativeResult, 'applied_with_evidence');
    assert.equal(intent?.replayState, 'awaiting_receipt');
    assert.equal((await projectNativeWaits(fixture.store, t02Scope)).length, 0);
  });

  test('keep_local_and_create derives a missing index from the live child list, never invents one', async () => {
    const fixture = await unknownWait();
    const { deps } = harness(fixture);
    await fixture.store.persistApplyIntentFacts(t02Scope, fixture.intent.intentId, { anchors: {} });
    const created: Array<{ index?: number }> = [];
    const create = fixture.api.create.bind(fixture.api);
    fixture.api.create = async (input) => { created.push(input); return create(input); };
    const response = await handleNativeWaitRequest(
      confirmMessage(fixture.wait, fixture.intent, 'keep_local_and_create'), deps);
    assert.equal(response.ok, true);
    // 'native-root' already holds the orphan, so the honest index is the tail.
    assert.deepEqual(created, [{ parentId: 'native-root', index: 1, title: 'Remote', url: 'https://example.test/' }]);

    const blind = await unknownWait();
    await blind.store.persistApplyIntentFacts(t02Scope, blind.intent.intentId, { anchors: {} });
    blind.api.getChildren = async () => { throw new Error("Can't find bookmark for id."); };
    const refused = await handleNativeWaitRequest(
      confirmMessage(blind.wait, blind.intent, 'keep_local_and_create'), harness(blind).deps);
    assert.deepEqual(refused, { ok: false, code: 'request_invalid' });
    assert.equal(blind.api.calls.filter((call) => call.kind === 'create').length, 1,
      'only the crashed fixture create may exist');
  });

  test('cancel settles the pull event and refuses a later conflicting decision', async () => {
    const fixture = await unknownWait();
    const { deps, wakes } = harness(fixture);
    assert.equal((await fixture.store.listPullEvents(t02Scope, ['awaiting_confirmation'])).length, 1);
    const response = await handleNativeWaitRequest(
      confirmMessage(fixture.wait, fixture.intent, 'cancel'), deps);
    assert.deepEqual(response, { ok: true, result: 'cancelled' });
    assert.deepEqual(wakes, [1]);

    const event = await fixture.store.getPullEvent(t02Scope, String(fixture.intent.eventId));
    assert.equal(String(event?.state), 'authority_committed');
    assert.equal((await fixture.store.listPullEvents(t02Scope, ['awaiting_confirmation'])).length, 0);
    const intent = await fixture.store.getApplyIntent(t02Scope, fixture.intent.intentId);
    assert.equal(intent?.nativeResultConfirmation?.code, fixture.waitRef);
    assert.equal(intent?.nativeResult, 'result_unknown');
    // The settled wait leaves the list, while another settings page cannot
    // reuse its old reference to reopen an already cancelled landing.
    assert.deepEqual(await projectNativeWaits(fixture.store, t02Scope), []);
    const late = fixture.api.all().find((node) => node.id.startsWith('created-'))!;
    const bound = await handleNativeWaitRequest(confirmMessage(fixture.wait, fixture.intent, 'bind', late.id), deps);
    assert.deepEqual(bound, { ok: false, code: 'native_result_cas' });
  });

  test('refuses impossible confirmations with named codes and never rejects', async () => {
    const fixture = await unknownWait();
    const { deps, wakes } = harness(fixture);
    const base = confirmMessage(fixture.wait, fixture.intent, 'bind', 'created-0');

    const stale = await handleNativeWaitRequest({ ...base, waitRef: 'nwr:stale' }, deps);
    assert.deepEqual(stale, { ok: false, code: 'stale_ref' });
    const generation = await handleNativeWaitRequest({ ...base, generation: t02Scope.generation + 1 }, deps);
    assert.deepEqual(generation, { ok: false, code: 'generation_mismatch' });
    const missing = await handleNativeWaitRequest({ ...base, intentId: 'intent:missing' }, deps);
    assert.deepEqual(missing, { ok: false, code: 'intent_not_found' });
    const keepMissingMessage: NativeWaitConfirmRequest = {
      kind: 'known.nativeWait.confirm', userGesture: true, waitRef: base.waitRef, intentId: 'intent:missing',
      generation: base.generation, action: 'keep_local_and_create',
    };
    const keepMissing = await handleNativeWaitRequest(keepMissingMessage, deps);
    assert.deepEqual(keepMissing, { ok: false, code: 'intent_not_found' });

    await fixture.store.putMapping(t02Scope, mapping('foreign-bookmark', 'other-colp'));
    const foreign = await handleNativeWaitRequest({ ...base, nativeId: 'foreign-bookmark' }, deps);
    assert.deepEqual(foreign, { ok: false, code: 'request_invalid' });

    const revoked = await handleNativeWaitRequest(base, harness(fixture, { permissionGranted: async () => false }).deps);
    assert.deepEqual(revoked, { ok: false, code: 'revoked' });
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 1,
      'a revoked permission must not reach Chrome');

    const offline = async (): Promise<never> => { throw new Error('not_connected'); };
    const disconnected = await handleNativeWaitRequest(base, harness(fixture, { scope: offline }).deps);
    assert.deepEqual(disconnected, { ok: false, code: 'not_connected' });
    const disconnectedList = await handleNativeWaitRequest({ kind: 'known.nativeWait.list' },
      harness(fixture, { scope: offline }).deps);
    assert.deepEqual(disconnectedList, { ok: false, code: 'not_connected' });

    // A broken store read is reported as an opaque code instead of rejecting onMessage.
    const broken = { ...(fixture.store as object), listApplyIntents: async () => { throw new TypeError('idb exploded'); } };
    const failedList = await handleNativeWaitRequest({ kind: 'known.nativeWait.list' },
      harness(fixture, { store: broken as unknown as NativeWaitDeps['store'] }).deps);
    assert.deepEqual(failedList, { ok: false, code: 'request_invalid' });
    assert.deepEqual(wakes, [], 'no failure may wake the engine');
  });
});

test('review: cancel survives the next native repair', async () => {
  const f = await unknownWait();
  const result = await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'cancel'), harness(f).deps);
  assert.deepEqual(result, { ok: true, result: 'cancelled' });
  await repairNativeSideEffects(f.store, t02Scope, f.api);
  assert.deepEqual(await projectNativeWaits(f.store, t02Scope), [], 'cancel must remain settled after repair');
});
test('review: bind rejects an id absent from Chrome', async () => {
  const f = await unknownWait();
  const result = await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', 'does-not-exist'), harness(f).deps);
  assert.equal(result.ok, false, 'an absent native cannot satisfy the remote landing');
  assert.equal(await f.store.getMappingByNativeId(t02Scope, 'does-not-exist'), null);
});
test('review: stale create confirmation causes no native mutation', async () => {
  const f = await unknownWait();
  const before = f.api.calls.filter(call => call.kind === 'create').length;
  const msg = confirmMessage(f.wait, f.intent, 'keep_local_and_create');
  const orphan = f.api.all().find(node => node.id.startsWith('created-'))!;
  await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', orphan.id), harness(f).deps);
  // A second settings tab still submits the original waitRef after the first tab binds.
  const result = await handleNativeWaitRequest(msg, harness(f).deps);
  assert.deepEqual(result, { ok: false, code: 'stale_ref' });
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, before, 'CAS must precede Chrome side effect');
});

test('review: valid bind resumes the real applier to a completed page', async () => {
  const f = await unknownWait();
  const orphan = f.api.all().find(node => node.id.startsWith('created-'))!;
  const result = await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', orphan.id), harness(f).deps);
  assert.equal(result.ok, true);
  await f.applier.resume();
  assert.equal((await f.store.listPullPages(t02Scope))[0]?.state, 'page_complete');
});

test('concurrent confirmations claim one create and a real receipt resumes the page', async () => {
  const f = await unknownWait(); const { deps } = harness(f);
  const message = confirmMessage(f.wait, f.intent, 'keep_local_and_create');
  const results = await Promise.all([handleNativeWaitRequest(message, deps), handleNativeWaitRequest(message, deps)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 2);
  await f.applier.resume();
  assert.equal((await f.store.listPullPages(t02Scope))[0]?.state, 'page_complete');
  assert.deepEqual(await projectNativeWaits(f.store, t02Scope), []);
  assert.equal((await pendingNativeOrPullFacts(f.store, t02Scope)).nativeResultUnknown, false);
  assert.ok((await handleNativeWaitRequest(message, deps)).ok, 'completed create is idempotent');
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 2);
});

test('a claimed user create survives failure before Chrome and resumes without a second user decision', async () => {
  const f = await unknownWait(); const { deps } = harness(f);
  const create = f.api.create.bind(f.api); let fail = true;
  f.api.create = async input => { if (fail) throw new Error('transient_failure'); return create(input); };
  assert.deepEqual(await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'keep_local_and_create'), deps),
    { ok: false, code: 'transient_failure' });
  fail = false;
  await repairNativeSideEffects(f.store, t02Scope, f.api);
  await f.applier.resume();
  assert.equal((await f.store.listPullPages(t02Scope))[0]?.state, 'page_complete');
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 2);
});

test('cancel stays settled through page completion and native repair', async () => {
  const f = await unknownWait();
  const message = confirmMessage(f.wait, f.intent, 'cancel');
  await handleNativeWaitRequest(message, harness(f).deps);
  await f.applier.resume();
  await repairNativeSideEffects(f.store, t02Scope, f.api);
  assert.deepEqual(await projectNativeWaits(f.store, t02Scope), []);
  assert.deepEqual(await pendingNativeOrPullFacts(f.store, t02Scope),
    { pendingIncompletePull: false, nativeResultUnknown: false });
  assert.equal((await f.store.listPullPages(t02Scope))[0]?.state, 'page_complete');
  assert.equal((await f.store.listPullIssues(t02Scope))[0]?.code, 'native_result_unknown', 'declined placement retains the unresolved native fact');
  assert.deepEqual(await handleNativeWaitRequest(message, harness(f).deps), { ok: true, result: 'duplicate' });
});

test('bind refuses an existing id under another parent or with the wrong node kind', async () => {
  for (const candidate of [
    { id: 'elsewhere', parentId: 'other-root', title: 'Remote', url: 'https://example.test/' },
    { id: 'folder', parentId: 'native-root', title: 'Remote' },
  ]) {
    const f = await unknownWait(); f.api.seed(candidate);
    assert.deepEqual(await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', candidate.id), harness(f).deps),
      { ok: false, code: 'request_invalid' });
    assert.equal((await projectNativeWaits(f.store, t02Scope)).length, 1);
    assert.equal(await f.store.getMappingByNativeId(t02Scope, candidate.id), null);
  }
});

test('cancellation wins atomically against a bind whose Chrome validation was already in flight', async () => {
  const f = await unknownWait(); const deps = harness(f).deps;
  const orphan = f.api.all().find(node => node.id.startsWith('created-'))!;
  const get = f.api.get.bind(f.api); let release!: () => void; let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.api.get = async id => { started(); await blocked; return get(id); };
  const binding = handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', orphan.id), deps);
  await entered;
  assert.deepEqual(await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'cancel'), deps),
    { ok: true, result: 'cancelled' });
  release();
  assert.deepEqual(await binding, { ok: false, code: 'native_result_cas' });
  assert.equal(await f.store.getMappingByNativeId(t02Scope, orphan.id), null);
  assert.deepEqual(await projectNativeWaits(f.store, t02Scope), []);
});

test('bind refuses private, managed, excluded and detached native targets', async () => {
  for (const restriction of ['private', 'managed', 'excluded', 'detached']) {
    const f = await unknownWait(); const orphan = f.api.all().find(node => node.id.startsWith('created-'))!;
    if (restriction === 'private') {
      await f.store.configureBrowserRoots(t02Scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
        selectedNativeIds: [], privateNativeIds: ['native-root'], status: 'ready' });
      assert.ok((await f.store.getScope(t02Scope))?.privateRoots?.includes('root-colp'));
    } else if (restriction === 'managed') {
      const get = f.api.get.bind(f.api);
      f.api.get = async id => (await get(id)).map(node => ({ ...node, unmodifiable: 'managed' }));
    } else if (restriction === 'excluded') {
      await f.store.putLocalSyncExclusion(t02Scope, { nativeId: orphan.id, rootNativeId: 'native-root',
        decisionId: 'keep-local', generation: 1, sourceKind: 'remote_delete' });
    } else {
      await f.store.detachMount(t02Scope, 'mount-bar');
    }
    const result = await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', orphan.id), harness(f).deps);
    assert.equal(result.ok, false, restriction);
    assert.equal(await f.store.getMappingByNativeId(t02Scope, orphan.id), null, restriction);
  }
});

test('a user create is refused when the authority moved while the user was deciding', async () => {
  const f = await unknownWait();
  const before = f.api.calls.filter(call => call.kind === 'create').length;
  const authority = {
    assertCurrent: async () => { throw Object.assign(new Error('authority_fenced'), { code: 'authority_fenced' }); },
    api: f.api,
  };
  const result = await handleNativeWaitRequest(
    confirmMessage(f.wait, f.intent, 'keep_local_and_create'), harness(f).deps, authority);
  assert.deepEqual(result, { ok: false, code: 'authority_fenced' });
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, before,
    'a fenced confirmation must not reach Chrome');
  const intent = await f.store.getApplyIntent(t02Scope, f.intent.intentId);
  assert.equal(intent?.nativeResult, 'result_unknown', 'the wait stays replayable under the current identity');
  assert.equal(intent?.nativeWaitDecision, undefined);
  assert.equal((await projectNativeWaits(f.store, t02Scope)).length, 1);
});

test('revoked permission refuses a user create before looking up a placement', async () => {
  const f = await unknownWait(); let reads = 0;
  f.api.getChildren = async () => { reads++; throw new Error('must_not_read'); };
  await f.store.persistApplyIntentFacts(t02Scope, f.intent.intentId, { anchors: {} });
  assert.deepEqual(await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'keep_local_and_create'),
    harness(f, { permissionGranted: async () => false }).deps), { ok: false, code: 'revoked' });
  assert.equal(reads, 0);
});


test('an existing folder can satisfy a folder wait and complete its real Pull page', async () => {
  const f = await unknownWait('Folder'); const orphan = f.api.all().find(node => node.id.startsWith('created-'))!;
  assert.equal(orphan.url, undefined);
  assert.deepEqual(await handleNativeWaitRequest(confirmMessage(f.wait, f.intent, 'bind', orphan.id), harness(f).deps),
    { ok: true, result: 'bound', nativeId: orphan.id });
  await f.applier.resume();
  assert.equal((await f.store.listPullPages(t02Scope))[0]?.state, 'page_complete');
});
