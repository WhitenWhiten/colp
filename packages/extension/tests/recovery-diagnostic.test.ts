import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { recordRecoveryDiagnostic } from '../src/recovery-diagnostic.js';
import type { SyncScope } from '../src/sync-state-store.js';
const scope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 } as const satisfies SyncScope;

test('recovery failures are durable and persistence failures use a non-secret fallback', async () => {
  const write = vi.fn(async () => {});
  await recordRecoveryDiagnostic({ putScopeDiagnostic: write }, scope, 'idle_compaction', 'compaction_failed');
  assert.deepEqual(write.mock.calls[0], [scope, { kind: 'idle_compaction', code: 'compaction_failed' }]);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await recordRecoveryDiagnostic({ putScopeDiagnostic: async () => { throw new Error('secret exception content'); } },
      scope, 'bookmark_event_recovery', 'failed');
    assert.deepEqual(warning.mock.calls, [['sync_recovery_diagnostic_unavailable', 'bookmark_event_recovery']]);
  } finally { warning.mockRestore(); }
});
