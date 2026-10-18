import 'fake-indexeddb/auto';
import { expect } from 'vitest';
import { setup, scope, bar } from './sync-recovery-hardening-fixture.js';
import { createBootstrapCoordinator, type ConfirmInput } from '../src/bootstrap/coordinator.js';
import { publicAttentionSummary } from '../src/bootstrap/attention-report.js';
export { scope };
export async function conflicted() {
  const store = await setup(); await store.putMapping(scope, bar); await store.setFirstRun(scope, 'completed');
  const localFacts: ConfirmInput['localFacts'] = Array.from({ length: 4 }, (_, i) => ({
    nativeId: `local-${i}`, mountNativeRootId: '1', parentNativeId: '1', kind: 'bookmark',
    title: `Local ${i}`, url: `https://example.test/${i}`,
  }));
  for (const [i, local] of localFacts.entries()) await store.putMapping(scope, {
    nativeId: local.nativeId, colpId: `remote-${i}`, rootNativeId: '1', nodeKind: 'bookmark',
    parentNativeId: '1', parentColpId: 'bar', projection: { revision: 'r1', digest: `sha256:${i}`,
      content: { title: local.title, url: local.url! } },
  });
  const input: ConfirmInput = { confirmationId: 'review', confirmationVersion: '1', treeDigest: 'sha256:review',
    localFacts, rootNodeId: 'root', mounts: [{ nativeRootId: '1', rootRole: 'bookmarks-bar', remoteMountNodeId: 'bar' }],
    remoteFacts: [
      { nodeId: 'root', parentId: null, title: '', kind: 'folder', folderRole: 'root', revision: 'r1' },
      { nodeId: 'bar', parentId: 'root', title: 'Bookmarks bar', kind: 'folder', folderRole: 'bookmarks-bar', revision: 'r1' },
      ...localFacts.map((local, i) => ({ nodeId: `remote-${i}`, parentId: 'bar', title: `Remote ${i}`,
        kind: 'bookmark' as const, url: local.url!, revision: 'r1' })),
    ] };
  const coordinator = createBootstrapCoordinator({ store, scope, randomUUID: () => 'review-run' });
  const view = await coordinator.confirm(input);
  expect(view.run.phase).toBe('needs_attention');
  expect(publicAttentionSummary(view.run.attention!).pendingCount).toBe(4);
  return { store, coordinator, input, view };
}

