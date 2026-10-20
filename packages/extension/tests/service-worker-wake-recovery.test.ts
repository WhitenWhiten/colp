import assert from 'node:assert/strict';
import { afterAll, beforeAll, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';

let f: Awaited<ReturnType<typeof liveWorker>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { errors = vi.spyOn(console, 'error'); f = await liveWorker(); });
afterAll(async () => { await f?.close(); errors.mockRestore(); });

test('an online wake refused before lane admission rejects its caller and releases the coalescing slot', async () => {
  const { scheduleSyncEngineWake } = await import('../src/sw/engine.js');
  f.local.fail = 'get';
  const refused = scheduleSyncEngineWake('online', 0, true);
  await assert.rejects(refused, /storage_unavailable/u);
  assert.equal(f.runtime.sw.confirmedOnlineWakePending, false);
  assert.equal(f.runtime.sw.coalescedOnlineWake, undefined);
  f.local.fail = undefined;
  const reads = f.local.calls.length, recovered = scheduleSyncEngineWake('online', 0, true);
  assert.notEqual(recovered, refused);
  await recovered;
  assert.ok(f.local.calls.length > reads, 'recovered online event enters the real coordinator again');
  assert.equal(f.runtime.sw.confirmedOnlineWakePending, false);
  assert.equal(f.runtime.sw.coalescedOnlineWake, undefined);
  assert.deepEqual(f.api.calls, []); assert.equal(errors.mock.calls.length, 0);
});
