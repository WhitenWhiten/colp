import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import { liveWorker, popupSender } from './service-worker-live-harness.js';

let f: Awaited<ReturnType<typeof liveWorker>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { errors = vi.spyOn(console, 'error'); f = await liveWorker(); });
afterEach(async () => {
  f.local.fail = f.local.failNext = f.session.fail = f.session.failNext = undefined;
  f.idbFault.database = ''; f.permission.granted = false;
  await f.runtime.workCoordinator.drain();
  assert.equal(errors.mock.calls.length, 0);
});
afterAll(async () => { await f?.close(); errors.mockRestore(); });

test('device history clear waits for the actual transaction, preserves it on refusal, and can retry', async () => {
  const { browserHistoryStore, BROWSER_HISTORY_DATABASE } = await import('../src/capture/browser-history-store.js');
  const scope = await (await import('../src/sw/capture-native.js')).currentCaptureScope();
  await browserHistoryStore.remember({ captureId: 'device-save', targetNativeId: '1', title: 'Kept',
    url: 'https://example.test/kept', source: 'manual-popup', automaticIntent: false,
    createdAt: Date.now() - 1000, savedAt: Date.now() - 1000 }, 'device-native');
  f.idbFault.database = BROWSER_HISTORY_DATABASE;
  assert.deepEqual(await f.send({ kind: 'known.deviceHistory.clear', userGesture: true }),
    { ok: false, error: 'database_unavailable' });
  f.idbFault.database = '';
  assert.equal((await browserHistoryStore.listForOwner(scope)).length, 1);
  assert.deepEqual(await f.send({ kind: 'known.deviceHistory.clear', userGesture: true }), { ok: true });
  assert.deepEqual(await browserHistoryStore.listForOwner(scope), []);
});

test('bookmark subscription messages execute the local settings store and reject a refused transaction', async () => {
  const message = { type: 'BOOKMARK_SUBSCRIPTIONS', requestId: '11111111-1111-4111-8111-111111111111', command: { kind: 'directoryDefaults' } };
  assert.deepEqual(await f.send(message), { ok: true, data: { mountParentNativeId: null, preservationParentNativeId: null } });
  f.idbFault.database = 'known-bookmark-subscriptions-v1';
  assert.deepEqual(await f.send(message), { ok: false, error: 'database_unavailable' });
});

for (const [message, response] of [
  [{ kind: 'known.roots.get' }, { ok: false, error: 'request_invalid' }],
  [{ kind: 'known.scope.rebuild.preview' }, { ok: false, code: 'rebuild_failed' }],
  [{ kind: 'known.nativeWait.confirm', userGesture: true, waitRef: 'wait', intentId: 'intent', generation: 1, action: 'cancel' },
    { ok: false, code: 'request_invalid' }],
  [{ kind: 'known.sync.attention.get' }, { ok: false, error: 'state_unavailable' }],
] as const) test(`${message.kind} refuses the actual failed storage operation without native changes`, async () => {
  const before = f.api.calls.length; f.local.fail = 'get';
  assert.deepEqual(await f.send(message), response); assert.equal(f.api.calls.length, before);
});

test('batch status rejects a refused native journal read, while save status keeps its explicit local fallback', async () => {
  f.permission.granted = true; f.idbFault.database = 'known-bookmark-batches';
  assert.deepEqual(await f.send({ kind: 'known.batch.status' }), { ok: false, error: 'database_unavailable' });
  f.idbFault.database = ''; f.local.fail = 'get';
  const status = await f.send({ kind: 'known.save.status' });
  assert.equal(status.ok, true); assert.equal(status.localOnly, true); assert.equal(status.status.kind, 'setup-required');
  assert.deepEqual(f.api.calls, []);
});

test('a page save reports a refused placement context instead of claiming a native create', async () => {
  f.permission.granted = true; f.local.fail = 'get';
  assert.deepEqual(await f.send({ kind: 'known.save.native', entry: 'page', userGesture: true }),
    { ok: false, error: 'create_failed' });
  assert.deepEqual(f.api.calls, []);
});

test('local favicon routes and the no-scope drain remain read-only and do not claim a saved icon', async () => {
  assert.deepEqual(await f.send({ kind: 'known.favicon.save-context-local' }), { ok: false });
  assert.deepEqual(await f.send({ kind: 'known.favicon.save-context' }), { ok: false });
  assert.deepEqual(await f.send({ kind: 'known.favicon.clear', nativeId: 'not-mapped' }), { ok: false, error: 'clear_failed' });
  assert.deepEqual(await f.send({ kind: 'known.favicon.drain' }), { ok: true });
  assert.deepEqual(f.api.calls, []);
});

test('scope and native-wait read messages return their real missing-authority contracts', async () => {
  assert.deepEqual(await f.send({ kind: 'known.scope.detach', mountId: 'absent' }), { ok: false, error: 'not_connected' });
  assert.equal((await f.send({ kind: 'known.remoteDelete.policy.get' })).ok, false);
  assert.equal((await f.send({ kind: 'known.nativeWait.list' })).ok, false);
  assert.deepEqual(await f.send({ kind: 'known.batch.status' }), { ok: false, error: 'permission_required' });
  assert.deepEqual(f.api.calls, []);
});

test('the worker forwards all five browser-rule command families to executable local handlers', async () => {
  const commands = [
    { kind: 'known.automation.browser.runPreview', scopeNativeId: '1' },
    { kind: 'known.automation.browser.config.export' },
    { kind: 'known.automation.browser.import.check', text: '{}' },
    { kind: 'known.automation.browser.subscription.check', url: 'invalid-url' },
    { kind: 'known.automation.browser.preview', sample: true },
  ];
  const responses = [];
  for (const command of commands) responses.push(await f.send(command));
  assert.deepEqual(responses[0], { ok: false, error: 'noAccess' });
  assert.equal(responses[1].ok, true); assert.equal(typeof responses[1].config.content, 'string');
  assert.equal(responses[2].ok, false); assert.equal(responses[3].ok, false);
  assert.deepEqual(responses[4], { ok: false, error: 'noAccess' }); assert.deepEqual(f.api.calls, []);
});

test('automation and risk state use real local indexes, including popup risk reads', async () => {
  const automation = await f.send({ kind: 'known.automation.state' });
  assert.equal(automation.ok, true); assert.equal(automation.state.account, 'signedOut');
  assert.deepEqual(automation.state.rules, []);
  const risk = await f.send({ kind: 'known.risk.state' });
  assert.equal(risk.ok, true); assert.deepEqual(risk.state.lists, []);
  assert.equal((await f.send({ kind: 'known.risk.check', url: 'https://example.test/' }, popupSender)).ok, true);
  f.idbFault.database = 'known-automation';
  for (const message of [{ kind: 'known.automation.state' }, { kind: 'known.risk.state' },
    { kind: 'known.automation.browser.config.export' }]) {
    assert.deepEqual(await f.send(message), { ok: false, error: 'database_unavailable' });
  }
});

test('auth and disconnect return a recoverable public state after one refused authority read', async () => {
  for (const message of [{ kind: 'known.auth.status' }, { kind: 'known.server.disconnect', userGesture: true }]) {
    f.local.failNext = 'get'; const response = await f.send(message);
    assert.equal(response.ok, false); assert.equal(response.error, 'storage_unavailable');
    assert.equal(response.state.status, 'error'); assert.equal(response.state.errorCode, 'storage_unavailable');
    assert.equal(await f.runtime.store.loadCredential(), null);
  }
  assert.deepEqual(f.api.calls, []);
});

test('signed-out auth status and explicit disconnect complete with no native mutation', async () => {
  assert.equal((await f.send({ kind: 'known.auth.status' })).state.status, 'signed_out');
  const disconnected = await f.send({ kind: 'known.server.disconnect', userGesture: true });
  assert.equal(disconnected.ok, true); assert.equal(disconnected.state.status, 'signed_out');
  assert.deepEqual(f.api.calls, []);
});
