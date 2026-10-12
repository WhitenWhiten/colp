import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';
import { createSyncStateStore } from '../src/sync-state-store.js';

const fixtures = vi.hoisted(() => {
  const scope = {
    environment: 'development' as const, serverId: 'server', serverOrigin: 'https://known.test',
    accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1,
  };
  const discovered = [
    { nativeId: 'bar', ancestorNativeIds: [] as string[] },
    { nativeId: 'local-folder', ancestorNativeIds: ['bar'] },
  ];
  const remoteRoot = { nodeId: 'remote-root', parentId: null, kind: 'folder' as const, title: '',
    folderRole: 'root', revision: 'remote-root-revision', childrenRevision: 'root-children' };
  const remoteBar = { nodeId: 'remote-bar', parentId: 'remote-root', kind: 'folder' as const, title: 'Bar',
    folderRole: 'bookmarks-bar', revision: 'remote-bar-revision', childrenRevision: 'bar-children', position: '0' };
  const remoteBookmark = { nodeId: 'remote-bookmark', parentId: 'remote-bar', kind: 'bookmark' as const,
    title: 'Cloud bookmark', url: 'https://cloud.test/', revision: 'remote-bookmark-revision', position: '0' };
  const snapshot = { snapshotId: 'snapshot-1', revision: 'revision-1', syncCursor: 'cursor-1',
    identityDigest: 'identity-1', remoteFacts: [remoteRoot, remoteBar, remoteBookmark], pageCount: 1 };
  const state: { queueBusy: boolean; commitCalls: number; snapshotCalls: number; origins: string[];
    plans: any[]; chromeTitle: string; snapshotChanged: boolean } = {
    queueBusy: false, commitCalls: 0, snapshotCalls: 0, origins: [], plans: [], chromeTitle: 'Local bookmark',
    snapshotChanged: false,
  };
  return { scope, discovered, snapshot, state };
});

vi.mock('../src/sw/runtime.js', () => ({
  sw: { rootViewTokens: undefined },
  store: {
    loadCredential: vi.fn(async () => ({ accessToken: 'access', subject: fixtures.scope.accountId })),
    loadSession: vi.fn(async () => ({ sessionId: 'session', collection: { collectionId: fixtures.scope.collectionId },
      replicaLease: { generation: String(fixtures.scope.generation) } })),
  },
  syncState: {
    listQueue: vi.fn(async () => fixtures.state.queueBusy ? [{ status: 'pending' }] : []),
    listBookmarkEventsByStatus: vi.fn(async () => []), listProjectionIntents: vi.fn(async () => []),
    hasRecoveryStaging: vi.fn(async () => false), listImportPlans: vi.fn(async () => []),
    listAckIntents: vi.fn(async () => []), getEngineState: vi.fn(async () => null),
    getScope: vi.fn(async () => ({ boundaryVersion: '1', privateRoots: [] })),
    listMountBindings: vi.fn(async () => []), listMappings: vi.fn(async () => []),
    listBootstrapRuns: vi.fn(async () => []), readAdvancedPlan: vi.fn(async () => null),
    bumpBoundaryVersion: vi.fn(async () => '2'), putScopePreview: vi.fn(async () => undefined),
    putMountBinding: vi.fn(async () => undefined), putBootstrapRun: vi.fn(async () => undefined),
    setFirstRun: vi.fn(async () => undefined),
    commitAdvancedPlan: vi.fn(async (_scope: unknown, input: any) => {
      fixtures.state.commitCalls += 1;
      const record = { planId: input.planId, metadata: input.metadata, digest: 'plan-record-digest',
        stepCount: input.steps.length, state: 'active', updatedAt: input.now };
      fixtures.state.plans = [record]; return record;
    }),
    listAdvancedPlans: vi.fn(async () => fixtures.state.plans),
  },
  hasBookmarkPermission: vi.fn(async () => true), extensionOrigin: vi.fn(() => 'chrome-extension://test'),
  rootScopeKey: (scope: typeof fixtures.scope) => JSON.stringify(scope),
}));

vi.mock('../src/sw/scope.js', () => ({
  currentSyncScope: vi.fn(async () => fixtures.scope), loadConfig: vi.fn(async () => ({ serverOrigin: fixtures.scope.serverOrigin })),
  pushSessionAuthority: vi.fn(async () => ({ credential: { accessToken: 'access', subject: fixtures.scope.accountId },
    session: { sessionId: 'session', collection: { collectionId: fixtures.scope.collectionId },
      replicaLease: { generation: String(fixtures.scope.generation) } } })),
}));

vi.mock('../src/sw/roots.js', () => ({
  readRootFolders: vi.fn(async () => ({ discovered: fixtures.discovered })),
  sameDiscovered: (left: readonly unknown[], right: readonly unknown[]) => JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock('../src/manifest-client.js', () => ({ fetchSyncEndpoints: vi.fn(async () => ({ syncSnapshot: 'https://known.test/snapshot' })) }));
vi.mock('../src/bootstrap/remote-snapshot.js', () => ({
  loadCompleteRemoteSnapshot: vi.fn(async (input: { origin: string }) => {
    fixtures.state.snapshotCalls += 1; fixtures.state.origins.push(input.origin);
    return fixtures.state.snapshotChanged && fixtures.state.snapshotCalls > 1
      ? { ...fixtures.snapshot, revision: 'revision-2', identityDigest: 'identity-2' } : fixtures.snapshot;
  }),
}));
vi.mock('../src/session-client.js', () => ({
  syncSessionNeedsRenewal: (session: { readonly expiresAt?: string }) => session.expiresAt === 'expired',
  sessionMatchesCredentialAuthority: async () => true,
}));
vi.mock('../src/kns-09-release.js', () => ({ kns09Paused: vi.fn(async () => false) }));
vi.mock('../src/bootstrap/advanced-run.js', () => ({ activateAdvancedPlan: vi.fn(async () => undefined) }));

vi.mock('../src/chrome-bookmark-tree.js', async () => {
  const actual = await vi.importActual<typeof import('../src/chrome-bookmark-tree.js')>('../src/chrome-bookmark-tree.js');
  return {
    ...actual,
    createChromeBookmarkTreeAdapter: () => ({ read: async () => ({ roots: [{ nativeId: 'bar', rootKind: 'bookmarks_bar',
      kind: 'folder', title: 'Bar', managed: false, children: [{ nativeId: 'local-bookmark', kind: 'bookmark',
        title: fixtures.state.chromeTitle, managed: false, url: 'https://local.test/', children: [] }] }] }) }),
  };
});

import { advancedFirstRunStatus, advancedPlanIdFromPreview, clearAdvancedPreviewCache,
  handleAdvancedFirstRunConfirm, handleAdvancedFirstRunPreview } from '../src/sw/advanced-first-run.js';
import { store, sw, syncState } from '../src/sw/runtime.js';

describe('advanced first-run service-worker handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { chrome?: unknown }).chrome = { bookmarks: {} };
    clearAdvancedPreviewCache(); fixtures.state.queueBusy = false; fixtures.state.commitCalls = 0;
    fixtures.state.snapshotCalls = 0; fixtures.state.origins = []; fixtures.state.plans = [];
    fixtures.state.snapshotChanged = false;
    fixtures.state.chromeTitle = 'Local bookmark';
    (sw as { rootViewTokens?: unknown }).rootViewTokens = {
      viewId: 'view', scopeKey: JSON.stringify(fixtures.scope), entries: new Map([
        ['bar-ref', { nativeId: 'bar', ancestorNativeIds: [] }],
        ['folder-ref', { nativeId: 'local-folder', ancestorNativeIds: ['bar'] }],
      ]),
    };
    vi.mocked(syncState.listQueue).mockImplementation(async () => fixtures.state.queueBusy ? [{ status: 'pending' }] as any : []);
  });

  test('preview reads a complete snapshot with extension Origin and leaves the durable scope untouched', async () => {
    const response = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'upload' });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok || !('previewId' in response)) return;
    assert.equal(response.advanced?.mode, 'upload');
    assert.equal(fixtures.state.commitCalls, 0);
    assert.deepEqual(fixtures.state.origins, ['chrome-extension://test']);
    assert.equal(response.boundaryVersion, '1');
    assert.equal(vi.mocked(syncState.bumpBoundaryVersion).mock.calls.length, 0);
    assert.equal(vi.mocked(syncState.putScopePreview).mock.calls.length, 0);
    assert.equal(vi.mocked(syncState.putMountBinding).mock.calls.length, 0);
  });

  test('stale local content rejects confirmation before commit and a repeated confirmation is idempotent', async () => {
    const preview = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'upload' });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok || !('previewId' in preview) || !preview.advanced) return;
    fixtures.state.chromeTitle = 'Changed after preview';
    const stale = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
      confirmationId: 'confirmation-1', libraryId: fixtures.scope.collectionId, bootstrapMode: 'upload',
      advancedConfirmation: preview.advanced });
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error, 'preview_stale'); assert.equal(fixtures.state.commitCalls, 0);
    fixtures.state.chromeTitle = 'Local bookmark';
    const invalidated = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
      confirmationId: 'confirmation-1', libraryId: fixtures.scope.collectionId, bootstrapMode: 'upload',
      advancedConfirmation: preview.advanced });
    assert.deepEqual(invalidated, { ok: false, error: 'preview_stale' });
    const replacement = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'upload' });
    assert.equal(replacement.ok, true);
    if (!replacement.ok || !('previewId' in replacement) || !replacement.advanced) return;
    const fresh = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: replacement.previewId,
      confirmationId: 'confirmation-1', libraryId: fixtures.scope.collectionId, bootstrapMode: 'upload',
      advancedConfirmation: replacement.advanced });
    assert.equal(fresh.ok, true); assert.equal(fixtures.state.commitCalls, 1);
    const calls = fixtures.state.snapshotCalls;
    const repeated = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: replacement.previewId,
      confirmationId: 'confirmation-1', libraryId: fixtures.scope.collectionId, bootstrapMode: 'upload',
      advancedConfirmation: preview.advanced });
    assert.deepEqual(repeated, fresh); assert.equal(fixtures.state.commitCalls, 1);
    assert.equal(fixtures.state.snapshotCalls, calls);
  });

  test('busy outbound work is rejected without reading or writing an advanced plan', async () => {
    fixtures.state.queueBusy = true;
    const response = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'download' });
    assert.deepEqual(response, { ok: false, error: 'sync_busy' });
    assert.equal(fixtures.state.snapshotCalls, 0); assert.equal(fixtures.state.commitCalls, 0);
  });

  test('advanced bootstrap cannot start again after first-run completion or a completed bootstrap Ack', async () => {
    vi.mocked(syncState.getScope).mockResolvedValueOnce({ boundaryVersion: '1', firstRun: 'completed' } as any);
    const completed = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'upload' });
    assert.deepEqual(completed, { ok: false, error: 'sync_busy' });
    vi.mocked(syncState.getScope).mockResolvedValue({ boundaryVersion: '1' } as any);
    vi.mocked(syncState.listAckIntents).mockResolvedValueOnce([{ kind: 'bootstrap', state: 'complete' }] as any);
    const acknowledged = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'download' });
    assert.deepEqual(acknowledged, { ok: false, error: 'sync_busy' });
  });

  test('a changed remote snapshot invalidates confirmation before any durable write', async () => {
    const preview = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'download' });
    assert.equal(preview.ok, true);
    if (!preview.ok || !('previewId' in preview) || !preview.advanced) return;
    fixtures.state.snapshotChanged = true;
    const response = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
      confirmationId: 'remote-version-change', libraryId: fixtures.scope.collectionId, bootstrapMode: 'download',
      advancedConfirmation: preview.advanced });
    assert.deepEqual(response, { ok: false, error: 'preview_stale', bookmarkCount: 1, folderCount: 1, skippedCount: 0 });
    assert.equal(fixtures.state.commitCalls, 0);
  });

  test('a missing session fails closed without refreshing or changing durable scope state', async () => {
    vi.mocked(store.loadSession).mockResolvedValueOnce(undefined as never);
    const response = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'upload' });
    assert.deepEqual(response, { ok: false, error: 'session_expired' });
    assert.equal(fixtures.state.snapshotCalls, 0); assert.equal(fixtures.state.commitCalls, 0);
  });

  test('an expired session also fails closed without invoking a refresh lane', async () => {
    vi.mocked(store.loadSession).mockResolvedValueOnce({ expiresAt: 'expired',
      collection: { collectionId: fixtures.scope.collectionId },
      replicaLease: { generation: String(fixtures.scope.generation) } } as never);
    const response = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'download' });
    assert.deepEqual(response, { ok: false, error: 'session_expired' });
    assert.equal(fixtures.state.snapshotCalls, 0); assert.equal(fixtures.state.commitCalls, 0);
  });

  test('plan identity is deterministic and depends on the preview', () => {
    assert.equal(advancedPlanIdFromPreview('preview-a'), advancedPlanIdFromPreview('preview-a'));
    assert.notEqual(advancedPlanIdFromPreview('preview-a'), advancedPlanIdFromPreview('preview-b'));
    assert.match(advancedPlanIdFromPreview('preview-a'), /^advanced\.plan\.[a-f0-9]{64}$/u);
  });

  test('the confirmed planner output is accepted by the actual IndexedDB record validator', async () => {
    const real = createSyncStateStore({ indexedDB: new IDBFactory() });
    await real.registerScope({ ...fixtures.scope, lifecycle: 'active', selectedRoots: [], boundaryVersion: '1',
      lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 }, checkpoint: { cursor: 'cursor', serverRevision: 'revision' } });
    vi.mocked(syncState.commitAdvancedPlan).mockImplementationOnce((scope, input) => real.commitAdvancedPlan(scope, input));
    const preview = await handleAdvancedFirstRunPreview({ kind: 'known.firstRun.preview', viewId: 'view',
      selectedRefs: ['bar-ref'], excludedRefs: [], bootstrapMode: 'download' });
    assert.ok(preview.ok && 'previewId' in preview && preview.advanced);
    const result = await handleAdvancedFirstRunConfirm({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
      confirmationId: 'durable-confirm', libraryId: fixtures.scope.collectionId, bootstrapMode: 'download',
      advancedConfirmation: preview.advanced });
    assert.equal(result.ok, true, JSON.stringify(result));
    const loaded = await real.readAdvancedPlan(fixtures.scope, advancedPlanIdFromPreview(preview.previewId));
    assert.ok(loaded?.steps.some((step) => step.definition.side === 'local' && step.definition.action === 'create'));
    real.close();
  });

  test('status reports attention from the durable bootstrap run or step state', async () => {
    fixtures.state.plans = [{ planId: 'advanced-plan', metadata: {}, state: 'active', updatedAt: 1 }];
    vi.mocked(syncState.listBootstrapRuns).mockResolvedValueOnce([{ runId: 'advanced-plan', phase: 'needs_attention' }] as any);
    const response = await advancedFirstRunStatus(fixtures.scope);
    assert.deepEqual(response, { ok: true, phase: 'needs_attention', firstRun: 'running' });
  });
});
