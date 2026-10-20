import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import { liveWorker, optionsSender, popupSender } from './service-worker-live-harness.js';

let f: Awaited<ReturnType<typeof liveWorker>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { errors = vi.spyOn(console, 'error'); f = await liveWorker(); });
afterEach(async () => {
  f.local.fail = f.session.fail = undefined; f.tabs.fail = false; f.permission.granted = false;
  await f.runtime.workCoordinator.drain();
  assert.equal(errors.mock.calls.length, 0, 'caught background failure is not successful entry execution');
});
afterAll(async () => { await f?.close(); errors.mockRestore(); });

test('the entire signed-out worker boots with a pinned credential area and answers real local state', async () => {
  assert.equal((await f.send({ kind: 'known.capture.cloudAvailable' })).available, false);
  const reply = await f.send({ kind: 'known.capture.list' });
  assert.equal(reply.ok, true); assert.deepEqual(reply.tasks, []);
  assert.deepEqual(f.api.calls, []); assert.equal(errors.mock.calls.length, 0);
});

test('foreign senders and unrecognized requests never reach the storage or native ports', () => {
  for (const [message, sender] of [[{ kind: 'known.capture.list' }, { ...optionsSender, id: 'foreign' }],
    [{ kind: 'known.capture.list', injected: true }, optionsSender],
    [{ kind: 'known.localBackup.export', format: 'json' }, popupSender]] as const) {
    const before = f.local.calls.length + f.session.calls.length, replies: unknown[] = [];
    assert.equal(f.listener(message, sender, value => replies.push(value)), false);
    assert.deepEqual(replies, []); assert.equal(f.local.calls.length + f.session.calls.length, before);
  }
  assert.deepEqual(f.api.calls, []);
});

const id = '11111111-1111-4111-8111-111111111111';
const edit = { kind: 'known.capture.edit', captureId: id, commandId: id, parentNativeId: '1',
  originalParentNativeId: '1', tags: [], userGesture: true };
const cancel = { kind: 'known.capture.edit.cancel', captureId: id, commandId: id, editCommandId: id, userGesture: true };
const history = { kind: 'known.capture.history', days: 7, timezone: 'UTC', status: 'all', q: '', source: '', collectionId: '' };

for (const [message, error] of [
  [{ kind: 'known.personalSync.status' }, 'not_connected'],
  [{ kind: 'known.metadataSync.status' }, 'not_connected'],
  [{ kind: 'known.metadataSync.configure', enabled: false, userGesture: true }, 'not_connected'],
  [{ kind: 'known.metadataRestore.confirm', token: id, userGesture: true }, 'metadata_preview_stale'],
  [{ kind: 'known.localBackup.export', format: 'json' }, 'permission_required'],
  [{ kind: 'known.localImport.preview', base64: 'invalid' }, 'input_invalid'],
  [{ kind: 'known.capture.links', captureId: id }, 'capture_not_found'],
  [{ kind: 'known.capture.learning' }, 'sign_in_required'],
  [{ kind: 'known.capture.control.quote' }, 'credit_price_unavailable'],
  [{ ...history, deviceScope: 'cloud' }, 'sign_in_required'],
  [{ kind: 'known.capture.navigation.resolve', nodeId: 'unbound', collectionId: 'absent' }, 'capture_scope_changed'],
  [edit, 'capture_edit_unavailable'], [cancel, 'capture_edit_unavailable'],
  [{ kind: 'known.capture.presented', captureId: id, nodeRevision: 'r1' }, 'capture_feedback_unavailable'],
  [{ kind: 'known.capture.batch.get', batchId: id }, 'capture_batch_not_found'],
  [{ kind: 'known.capture.start', commandId: id, trigger: 'manual-popup', userGesture: true,
    url: 'https://example.test/', title: 'Save', saveAnother: false, allowUnverifiedCloud: false }, 'permission_required'],
  [{ kind: 'known.import.status' }, 'not_connected'],
  [{ kind: 'known.sync.ingressDiagnostics.get' }, 'not_connected'],
  [{ kind: 'known.sync.rejoinDecisions.get' }, 'not_connected'],
  [{ kind: 'known.firstRun.status' }, 'not_connected'],
] as const) test(`${message.kind} reports the actual unavailable precondition without native writes`, async () => {
  const before = f.api.calls.length;
  assert.deepEqual(await f.send(message), { ok: false, error });
  assert.equal(f.api.calls.length, before);
});

for (const message of [
  { kind: 'known.deviceHistory.clear', userGesture: true },
  { kind: 'known.metadataRestore.confirm', token: id, userGesture: true },
  { kind: 'known.personalSync.preview', action: 'disconnect' },
  { kind: 'known.metadataSync.configure', enabled: false, userGesture: true },
  { kind: 'known.localImport.status' },
  { type: 'BOOKMARK_SUBSCRIPTIONS', requestId: id, command: { kind: 'list' } },
  { kind: 'known.risk.state' }, { kind: 'known.automation.browser.config.export' },
  { kind: 'known.sync.rejoinDecisions.get' },
]) test(`Options-only ${message.kind ?? message.type} refuses the real popup sender before any port access`, () => {
  const reads = f.local.calls.length + f.session.calls.length, replies: unknown[] = [];
  assert.equal(f.listener(message, popupSender, value => replies.push(value)), false);
  assert.deepEqual(replies, []); assert.equal(f.local.calls.length + f.session.calls.length, reads);
});

for (const message of [
  { kind: 'known.metadataSync.status' }, { kind: 'known.metadataSync.configure', enabled: false, userGesture: true },
  { kind: 'known.capture.diagnostics' }, { kind: 'known.capture.links', captureId: id },
  { kind: 'known.capture.control' }, { kind: 'known.capture.learning' }, history,
  { kind: 'known.capture.navigation.get' }, edit, cancel,
  { kind: 'known.capture.presented', captureId: id, nodeRevision: 'r1' },
  { kind: 'known.capture.batch.get', batchId: id }, { kind: 'known.capture.get', captureId: id },
  { kind: 'known.import.status' },
]) test(`${message.kind} answers a failed browser storage read once without inventing success`, async () => {
  const before = f.api.calls.length; f.local.fail = 'get';
  assert.deepEqual(await f.send(message), { ok: false, error: 'storage_unavailable' });
  assert.equal(f.api.calls.length, before);
});

test('cloud availability falls back to false when its real scope read fails', async () => {
  f.local.fail = 'get';
  assert.deepEqual(await f.send({ kind: 'known.capture.cloudAvailable' }), { ok: true, available: false });
});

test('classification and preferences retain their public error contracts after a storage failure', async () => {
  f.local.fail = 'get';
  assert.deepEqual(await f.send({ kind: 'known.classification.session' }),
    { ok: false, error: 'reconnect_required', status: 401, sameRequestRetrySafe: false });
  assert.deepEqual(await f.send({ kind: 'known.bookmark.preferences.get' }), { ok: false, error: 'preferences_unavailable' });
});

test('local navigation, preferences, import status and capture history remain executable without account authority', async () => {
  assert.deepEqual(await f.send({ kind: 'known.capture.navigation.set', hash: '#history' }), { ok: true });
  assert.equal((await f.send({ kind: 'known.capture.navigation.get' })).hash, '#history');
  const preferences = await f.send({ kind: 'known.bookmark.preferences.local' });
  assert.equal(preferences.ok, true); assert.equal(preferences.preferences.bookmarkInsertPosition, 'bottom');
  assert.deepEqual(await f.send({ kind: 'known.localImport.status' }), { ok: true, status: null });
  const localHistory = await f.send(history);
  assert.equal(localHistory.ok, true); assert.deepEqual(localHistory.items, []);
  assert.deepEqual(await f.send({ kind: 'known.capture.context' }), { ok: true, actionPopup: false });
  const diagnostics = await f.send({ kind: 'known.capture.diagnostics' });
  assert.equal(diagnostics.ok, true); assert.equal(diagnostics.diagnostic.reason, 'permission_required');
  assert.deepEqual(await f.send({ kind: 'known.sync.progress.get' }), { ok: true, progress: null });
});

test('the native window save waits for a real browser preview tab and reports a refused tab', async () => {
  assert.deepEqual(await f.send({ kind: 'known.save.native', entry: 'window', userGesture: true }),
    { ok: true, previewOpened: true });
  assert.ok(f.opened.some(row => 'url' in row && String(row.url).includes('capture-tabs.html')));
  f.tabs.fail = true;
  assert.deepEqual(await f.send({ kind: 'known.save.native', entry: 'window', userGesture: true }),
    { ok: false, error: 'preview_unavailable' });
});

test('native organize, pin and page-save permission refusals execute their real handlers', async () => {
  assert.deepEqual(await f.send({ kind: 'known.bookmarks.organize.preview' }), { ok: false, error: 'permission_required', moved: 0 });
  assert.deepEqual(await f.send({ kind: 'known.bookmarks.pin.set', nativeId: '1', pinned: true, userGesture: true }),
    { ok: false, error: 'permission_required' });
  const save = await f.send({ kind: 'known.save.native', entry: 'page', userGesture: true });
  assert.equal(save.ok, false); assert.equal(save.error, 'permission_required');
  assert.deepEqual(f.api.calls, []);
});
