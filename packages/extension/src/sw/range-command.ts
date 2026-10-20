import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { scanBoundary } from '../bookmark-boundary.js';
import { localFactsFromRoots } from '../bootstrap/local-facts.js';
import { createChromeBookmarkTreeAdapter, type NormalizedBookmarkRoot } from '../chrome-bookmark-tree.js';
import { confirmAddRange, rejoinScopeMount } from '../scope-commands.js';
import { adoptSelectedSubtreeMappings, applyConfirmedRange, discoveredFromRoots,
  releaseReincludedPrivateMappings } from '../scope-range.js';
import { collectNativeIds } from '../scope-reconcile.js';
import type { BoundaryCommandRecord, ScopePreviewRecord, SyncScope } from '../sync-state-store.js';
import type { PublicRangePreview, RootRequest } from '../types.js';
import { nativeChromeFacts } from './native-chrome.js';
import { readRootFolders } from './roots.js';
import { syncState, workCoordinator } from './runtime.js';
import type { BoundaryAttempt } from './boundary-attempt.js';
import { enqueueRangeDeletion, type FrozenRangeDeletion } from './range-remote-commands.js';

export interface PreparedRangeCommand {
  readonly request: Extract<RootRequest, { kind: 'known.roots.confirm' }>;
  readonly libraryId: string; readonly preview: PublicRangePreview;
  readonly selectedNativeIds: readonly string[]; readonly privateNativeIds: readonly string[];
  readonly keepNativeIds: readonly string[]; readonly unmountNativeIds: readonly string[];
  readonly previousPrivateRoots: readonly string[]; readonly previousPrivateNativeIds: readonly string[];
  readonly rejoinNativeIds: readonly string[]; readonly bootstrapNeeded: boolean;
  readonly rootNodeId?: string; readonly deletions: readonly FrozenRangeDeletion[];
}

/** Each step can be replayed after its side effect but before its checkpoint.
 * No transaction spans the native bookmark API. Pending/failed commands retain
 * the boundary until all writes and immutable queue intents are durable. */
export async function executeRangeCommand(scope: SyncScope, admitted: BoundaryCommandRecord,
  preview: ScopePreviewRecord, attempt: BoundaryAttempt,
  crash?: (boundary: string) => void): Promise<void> {
  const plan = admitted.payload as unknown as PreparedRangeCommand;
  let command = admitted;
  let native: Promise<{ readonly roots: readonly NormalizedBookmarkRoot[] }> | undefined;
  const tree = () => native ??= attempt.nativeApi(personalTreeApi()).then(api => createChromeBookmarkTreeAdapter(api).read());
  const step = async (name: string, work: () => Promise<void>) => {
    if (command.completedSteps.includes(name)) return;
    await attempt.assertCurrent();
    command = await syncState.advanceBoundaryCommand(scope, command.commandId, {});
    await work();
    crash?.(`after:${name}`);
    await attempt.assertCurrent();
    command = await syncState.advanceBoundaryCommand(scope, command.commandId, { step: name });
  };
  await step('mounts', async () => {
    await applyConfirmedRange(syncState, scope, { preview, keepNativeIds: plan.keepNativeIds,
      unmountNativeIds: plan.unmountNativeIds, remoteDeleteNativeIds: plan.deletions.map(row => row.nativeId) });
  });
  for (const nativeId of plan.rejoinNativeIds) await step(`rejoin:${nativeId}`, async () => {
    const mount = (await syncState.listMountBindings(scope)).find(row => row.nativeRootId === nativeId);
    if (!mount) throw new Error('mount_not_found');
    if (mount.status === 'active') return;
    const present = collectNativeIds((await tree()).roots);
    const result = await workCoordinator.run('bookmark', async () => {
      await attempt.assertCurrent();
      return rejoinScopeMount(syncState, scope, mount.mountId, present, [...present],
        await attempt.nativeApi({ ...nativeChromeFacts(), admittedNativeRootIds: plan.selectedNativeIds }));
    });
    if (result.mount.status !== 'active') throw new Error('rejoin_pending');
  });
  if (plan.bootstrapNeeded) await step('bootstrap', async () => {
    const response = await confirmAddRange(syncState, scope, { previewId: preview.previewId,
      confirmationId: command.commandId, treeDigest: preview.treeDigest, consumePreview: false,
      localFacts: localFactsFromRoots((await tree()).roots, plan.selectedNativeIds,
        preview.boundary.excludedNativeIds, plan.privateNativeIds, await syncState.listMountBindings(scope)),
      preserveBoundaryNativeIds: plan.deletions.map(row => row.nativeId),
      ...(plan.rootNodeId ? { rootNodeId: plan.rootNodeId } : {}) });
    if (!response.ok) throw new Error(response.error);
  });
  await step('private-mappings', async () => {
    await releaseReincludedPrivateMappings(syncState, scope, {
      previousPrivateRoots: plan.previousPrivateRoots, previousPrivateNativeIds: plan.previousPrivateNativeIds,
      privateNativeIds: plan.privateNativeIds, discovered: discoveredFromRoots((await tree()).roots),
    });
  });
  await step('subtree-mappings', async () => {
    const roots = (await tree()).roots;
    const scan = scanBoundary({ roots, selectedNativeIds: plan.selectedNativeIds,
      excludedNativeIds: preview.boundary.excludedNativeIds, privateNativeIds: plan.privateNativeIds,
      existingMounts: await syncState.listMountBindings(scope) });
    await adoptSelectedSubtreeMappings(syncState, scope, preview, scan, discoveredFromRoots(roots));
  });
  await step('root-authority', async () => {
    const { discovered } = await readRootFolders(await attempt.nativeApi(personalTreeApi()));
    await syncState.configureBrowserRoots(scope, { discovered, selectedNativeIds: plan.selectedNativeIds,
      privateNativeIds: plan.privateNativeIds, status: 'ready', expectedBoundaryVersion: command.boundaryVersion });
  });
  for (const deletion of plan.deletions) await step(`remote-delete:${deletion.nativeId}`,
    () => enqueueRangeDeletion(scope, preview, deletion, attempt.assertCurrent));
  await attempt.assertCurrent();
  await syncState.advanceBoundaryCommand(scope, command.commandId, { result: { ok: true } });
}
