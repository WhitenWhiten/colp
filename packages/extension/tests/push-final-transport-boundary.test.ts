import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createAuthorityFence } from '../src/authority-fence.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { batchBoundaryFixture, assertUnsentOriginals } from './queued-upload-batch-boundary-harness.js';
import { scope } from './bookmark-event-queue-harness.js';

for (const count of [1, 3]) for (const changed of ['none', 'private', 'exclusion', 'mapping_loss'] as const)
test(`a ${count}-operation actual effect fetch checks ${changed} after its final authority await`, async () => {
  const f = await batchBoundaryFixture(count);
  try {
    const fence = createAuthorityFence(new MemoryStorageArea()), context = await fence.capture();
    let entered = false;
    const effects = createSyncEffectAuthority({ scope, context, api: createChromePullBookmarkApi(),
      fetch: f.options.fetch, assertWritable: generation => fence.assertWritable(generation),
      currentScope: async () => {
        expect(await f.store.getScope(scope)).not.toBeNull();
        if (!entered) {
          entered = true;
          const node = f.nodes.at(-1)!;
          if (changed === 'private') f.api.put({ ...f.api.node(node.id), parentId: 'root-private' });
          else if (changed === 'exclusion') await f.store.putLocalSyncExclusion(scope, {
            nativeId: node.id, rootNativeId: 'root-selected', decisionId: 'after-worker-final-guard', generation: scope.generation,
          });
          else if (changed === 'mapping_loss') await f.store.deleteMapping(scope, 'root-private');
        }
        return scope;
      } });
    await createOutboundPushWorker({ ...f.options, fetch: effects.fetch }).drain();
    expect(entered).toBe(true);
    if (changed === 'none') {
      expect(f.sent).toHaveLength(1);
      for (const row of f.original) expect(await f.store.getQueueReceipt(scope, row.sequence)).toMatchObject({ kind: 'terminal', opId: row.opId });
    } else await assertUnsentOriginals(f);
  } finally { f.store.close(); }
});
