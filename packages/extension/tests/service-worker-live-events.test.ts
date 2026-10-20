import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';

let f: Awaited<ReturnType<typeof liveWorker>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { errors = vi.spyOn(console, 'error'); f = await liveWorker(); });
afterEach(async () => {
  f.local.fail = f.session.fail = undefined; f.idbFault.database = '';
  await f.runtime.workCoordinator.drain();
  assert.equal(errors.mock.calls.length, 0, 'every background failure must be explicitly asserted');
});
afterAll(async () => { await f?.close(); errors.mockRestore(); });

async function failures(expected: readonly string[]) {
  await vi.waitFor(() => assert.equal(errors.mock.calls.length, expected.length));
  assert.deepEqual(errors.mock.calls.map(([message]: unknown[]) => message).sort(),
    expected.map(reason => `[known] background task failed (${reason})`).sort());
  for (const [, error] of errors.mock.calls) assert.match(String(error), /storage_unavailable|database_unavailable/u);
  errors.mockClear();
}

test('startup independently reports each refused capture/preferences read without native or HTTP work', async () => {
  const requests = f.requests.length; f.local.fail = 'get';
  f.startup.emit();
  await failures(['startup.bookmark-preferences', 'startup.captures', 'startup.capture-batches',
    'startup.capture-feedback', 'startup.capture-reports', 'bookmark-recovery.sync-engine-wake']);
  assert.deepEqual(f.api.calls, []); assert.equal(f.requests.length, requests);
});

test('the capture alarm reports all four failed durable reads and a later retry completes', async () => {
  const { CAPTURE_ALARM } = await import('../src/sw/capture.js');
  f.local.fail = 'get'; f.alarms.emit({ name: CAPTURE_ALARM, scheduledTime: Date.now() });
  await failures(['alarm.captures', 'alarm.capture-batches', 'alarm.capture-feedback', 'alarm.capture-reports']);
  f.local.fail = undefined;
  f.alarms.emit({ name: CAPTURE_ALARM, scheduledTime: Date.now() });
  const { captureStore } = await import('../src/sw/capture.js');
  const scope = await (await import('../src/sw/capture-native.js')).currentCaptureScope();
  assert.deepEqual(await captureStore.listForOwner(scope), []);
  assert.deepEqual(f.api.calls, []);
});

test('only a trusted online event wakes captures, and failures remain observable', async () => {
  const reads = f.local.calls.length; f.online.emit({ isTrusted: false });
  assert.equal(f.local.calls.length, reads);
  f.local.fail = 'get'; f.online.emit({ isTrusted: true });
  await failures(['online.captures', 'online.capture-batches', 'online.bookmark-preferences',
    'online.capture-feedback', 'online.capture-reports', 'online.sync-engine-wake']);
  assert.deepEqual(f.api.calls, []);
});

test('a refused deferred-unpin read is logged without making a native move', async () => {
  const { PIN_PLACEMENT_ALARM } = await import('../src/sw/bookmark-pins.js');
  f.session.fail = 'get'; f.alarms.emit({ name: PIN_PLACEMENT_ALARM, scheduledTime: Date.now() });
  await failures(['alarm.pin-placement']); assert.deepEqual(f.api.calls, []);
});

test('a failed local import journal read is logged and does not become a completed import', async () => {
  const { LOCAL_IMPORT_ALARM } = await import('../src/sw/local-import.js');
  f.idbFault.database = 'known-local-import';
  f.alarms.emit({ name: LOCAL_IMPORT_ALARM, scheduledTime: Date.now() });
  await failures(['alarm.local-imports']);
  f.idbFault.database = '';
  assert.deepEqual(await f.send({ kind: 'known.localImport.status' }), { ok: true, status: null });
  assert.deepEqual(f.api.calls, []);
});

test('an extension update reports a refused durable confirmation retirement', async () => {
  // Chrome can refuse a transaction after the database has already opened.
  f.idbFault.database = (await import('../src/sync-state-store.js')).DATABASE_NAME;
  await Promise.all(f.installed.emit({ reason: 'update' }));
  await failures(['install.classification-confirmations']);
  assert.equal(f.opened.length, 0); assert.deepEqual(f.api.calls, []);
});

test('an install marks the welcome state before opening Options', async () => {
  await Promise.all(f.installed.emit({ reason: 'install' }));
  assert.equal((await f.local.get(f.runtime.WELCOME_FLAG))[f.runtime.WELCOME_FLAG], 'installed');
  assert.deepEqual(f.opened, [{ options: true }]);
});

test('a sync alarm reports failed admission and leaves the next wake executable', async () => {
  f.local.fail = 'get'; f.alarms.emit({ name: 'known-sync-engine', scheduledTime: Date.now() });
  await failures(['alarm.sync-engine-wake']);
  f.local.fail = undefined;
  await (await import('../src/sw/engine.js')).scheduleSyncEngineWake('alarm');
  assert.deepEqual(f.api.calls, []);
});

for (const message of [{ kind: 'known.sync.engine.retry' },
  { kind: 'known.bookmarkAnnotation.changed', nativeId: '1' },
  { kind: 'known.folderDescription.changed', nativeId: '1' }]) {
  test(`${message.kind} acknowledges its notification and separately reports a failed wake`, async () => {
    f.local.fail = 'get'; assert.deepEqual(await f.send(message), { ok: true });
    await failures(['message.sync-engine-wake']); assert.deepEqual(f.api.calls, []);
  });
}

test('connectivity acknowledgement is usable offline and after a refused online wake', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const reads = f.local.calls.length;
  assert.deepEqual(await f.send({ kind: 'known.connectivity.online' }), { ok: true });
  assert.equal(f.local.calls.length, reads);
  vi.stubGlobal('navigator', { onLine: true }); f.local.fail = 'get';
  assert.deepEqual(await f.send({ kind: 'known.connectivity.online' }), { ok: true });
  await failures(['message.bookmark-preferences']);
  assert.equal(f.runtime.sw.confirmedOnlineWakePending, false);
});

test('the rule refresh alarm exposes both refused indexes instead of claiming a successful refresh', async () => {
  const { RULE_SUBSCRIPTION_ALARM } = await import('../src/sw/automation-subscriptions.js');
  f.idbFault.database = 'known-automation';
  f.alarms.emit({ name: RULE_SUBSCRIPTION_ALARM, scheduledTime: Date.now() });
  await failures(['alarm.subscriptions', 'alarm.risk-lists']); assert.deepEqual(f.api.calls, []);
});

test('the automation alarm reports failed durable account and observed-create reads independently', async () => {
  await f.connect();
  const { AUTOMATION_ALARM } = await import('../src/sw/automation.js');
  f.idbFault.database = 'known-automation';
  f.alarms.emit({ name: AUTOMATION_ALARM, scheduledTime: Date.now() });
  await failures(['alarm.automation', 'alarm.observed-creates']); assert.deepEqual(f.api.calls, []);
});
