import 'fake-indexeddb/auto';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createAuthorityFence } from '../src/authority-fence.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { batchBoundaryFixture } from './queued-upload-batch-boundary-harness.js';
import { scope } from './bookmark-event-queue-harness.js';

beforeEach(() => { vi.resetModules(); });

for (const change of ['none', 'pause', 'pause_resume', 'scope_unavailable'] as const)
test(`the actual effect transport keeps its personal lease through the final ${change} proof`, async () => {
  const f = await batchBoundaryFixture(1);
  try {
    const personal = await import('../src/personal-sync-fetch.js');
    const { createSyncEffectAuthority } = await import('../src/sync-effect-authority.js');
    const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
    await policy.write(scope, 'enabled'); personal.configurePersonalSyncTransport(policy);
    const fence = createAuthorityFence(new MemoryStorageArea()), context = await fence.capture();
    let admitted = false, checked = false;
    const effects = createSyncEffectAuthority({ scope, context, api: createChromePullBookmarkApi(),
      fetch: personal.personalSyncFetch(scope, f.options.fetch!),
      assertWritable: generation => fence.assertWritable(generation), currentScope: async () => {
        if (change === 'scope_unavailable') throw new Error('storage read failed');
        admitted = true; return scope;
      } });
    await createOutboundPushWorker({ ...f.options, fetch: effects.fetch, assertUploadAllowed: async row => {
      await f.guard(row);
      if (admitted && !checked) {
        checked = true;
        if (change === 'pause' || change === 'pause_resume') await policy.write(scope, 'paused');
        if (change === 'pause_resume') await policy.write(scope, 'enabled');
      }
    } }).drain();
    expect(checked).toBe(change !== 'scope_unavailable');
    const row = (await f.store.getQueueByOpId(scope, f.original[0]!.opId))!;
    if (change === 'none') {
      expect(f.sent).toHaveLength(1); expect(await f.store.getQueueReceipt(scope, row.sequence)).toMatchObject({ kind: 'terminal' });
    } else {
      expect(f.sent).toEqual([]); expect(await f.store.getQueueReceipt(scope, row.sequence)).toBeNull();
      expect(row).toMatchObject({ payload: f.original[0]!.payload, digest: f.original[0]!.digest, status: 'unknown',
        recovery: { code: change === 'scope_unavailable' ? 'authority_fenced' : 'personal_sync_stopped' } });
    }
  } finally { f.store.close(); }
});
