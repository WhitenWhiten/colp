import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';

for (const [bootFailure, reasons] of [
  ['authority', ['startup.bind-library', 'startup.replica-rebuild-resume', 'bookmark-recovery.sync-engine-wake']],
  ['legacy-purge', ['startup.legacy-authority-purge']],
  ['local-import', ['startup.local-imports']],
] as const) test(`boot survives a refused ${bootFailure} port and the real operation can retry`, async () => {
  const errors = vi.spyOn(console, 'error');
  const f = await liveWorker({ bootFailure });
  try {
    await vi.waitFor(() => assert.equal(errors.mock.calls.length, reasons.length));
    assert.deepEqual(errors.mock.calls.map(([message]) => message).sort(),
      reasons.map(reason => `[known] background task failed (${reason})`).sort());
    for (const [, error] of errors.mock.calls) assert.match(String(error), /storage_unavailable|database_unavailable/u);
    assert.deepEqual(f.api.calls, []);
    f.local.fail = undefined; f.idbFault.database = '';
    if (bootFailure === 'legacy-purge') {
      assert.deepEqual((await f.local.get('known.auth.credential.v1'))['known.auth.credential.v1'], { obsoleteFixture: true });
      await (await import('../src/sw/credential-storage.js')).purgeLegacyLocalAuthority(f.local);
      assert.equal((await f.local.get('known.auth.credential.v1'))['known.auth.credential.v1'], undefined);
    }
    await (await import('../src/sw/library.js')).bindLibraryOnStartup();
    await (await import('../src/sw/local-import.js')).wakeLocalImports();
    assert.deepEqual(await f.send({ kind: 'known.localImport.status' }), { ok: true, status: null });
    assert.equal(errors.mock.calls.length, reasons.length, 'the healthy retry adds no hidden background failures');
  } finally { await f.close(); errors.mockRestore(); }
});
