import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { buildAttentionReport, pageAttention } from '../src/bootstrap/attention-report.js';
import type { LocalMatchReport } from '../src/bootstrap/matcher.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { scope } from './kns-05-pull-harness.js';
test('all 5000 local merge differences survive durable paging and restart', async () => {
  const report: LocalMatchReport = { kind: 'local-match-report', scopeKey: 'audit', reportDigest: 'sha256:audit',
    matched: [], localOnly: [], remoteOnly: [], candidates: [], planned: [], collectionRootDirectBookmarks: 0,
    emptyRemote: false, mountResolveRoles: [], conflicts: Array.from({length:5000}, (_,i) => ({ kind: 'title',
      localNativeId: `local-${i}`, remoteNodeId: `remote-${i}` })) };
  const attention = buildAttentionReport({ runId: 'audit-run' }, report, Date.now());
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'l', expiresAt: 9999999999999 }, checkpoint: { cursor: 'c0', serverRevision: 'r0' }, selectedRoots: [] });
  await store.putBootstrapRun(scope, { runId: 'audit-run', phase: 'needs_attention', confirmationId: 'confirm',
    treeDigest: 'digest', confirmationVersion: '1', bootstrapMode: 'merge',
    updatedAt: Date.now(), attention });
  store.close();
  const restarted = createSyncStateStore({ indexedDB });
  const loaded = (await restarted.listBootstrapRuns(scope))[0]!.attention!;
  let cursor: string | undefined; let fetched = 0;
  do { const page = pageAttention(loaded, cursor); fetched += page.items.length; cursor = page.nextCursor; } while (cursor);
  assert.equal(fetched, 5000);
});

