import { settleLocalTransferOwnership } from './local-transfer-ownership.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { createSourceLayout } from './layout.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { currentFlat, nativeFolderLookup } from '../sw/automation-browser.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
import { installSourcePlanAuthorization } from './planned-runtime.js';
import { contentBindings, isManagedContentMove } from './content-runtime.js';
import { captureStore } from '../sw/capture.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { workCoordinator } from '../sw/runtime.js';
import { unsettledCloudDestination } from '../classification-destination-boundary.js';
import { installBookmarkOwnershipObserver } from '../bookmark-ownership.js';
import { isReconcileNativeMutation } from './reconcile-executor.js';

export const sourceLayout = createSourceLayout(siteLedger.db, {
  localFirst: true,
  rules: currentFlat, paused: sourceAutomationsPaused, deviceId: captureDeviceId,
  lookup: nativeFolderLookup, assertRoot: async binding => { await assertSourceRoot(binding); },
  destination: async binding => {
    const target = await assertSourceRoot(binding), scope = await currentCaptureScope();
    return target.inRange ? { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId } : null;
  },
  sourceCopies: async input => {
    const { semanticContext, scopedSemanticBindings, importSharedSemantic } = await import('./semantic-associations.js');
    const { readSourceConnection } = await import('./content-identity.js');
    const { identityDefinition } = await import('./registry.js');
    const context = await semanticContext(input.root.nativeId), connection = await readSourceConnection(siteLedger.db, input.connectionId);
    const definition = identityDefinition(connection.siteKey, connection.identityVersion);
    const content = { siteKey: connection.siteKey, identityVersion: connection.identityVersion, itemId: input.itemId,
      ...(definition.contentIdScope !== 'site' ? { accountId: connection.accountId } : {}) };
    try { await scopedSemanticBindings(content, context.scope, input.scopeId); } catch (error) {
      if (input.policy.copies !== 'sourceAndSemantic' || !(error instanceof Error) || error.message !== 'semanticBindingNeedsReview') throw error;
    }
    if (context.library && context.scopeId === input.scopeId && input.policy.copies !== 'sourceAndSemantic')
      await importSharedSemantic(content, context.scope, input.scopeId, [input.connectionId], `cached:${input.connectionId}:${input.itemId}`);
    return contentBindings.sourceDecision(input);
  },
  beforeExclusion: assertNoCloudDestinationWork,
});
export function installSourceLayout() {
  installSourcePlanAuthorization((plan, effect) => sourceLayout.authorize(plan, effect));
  installBookmarkOwnershipObserver(async event => {
    if (['changed', 'moved', 'removed'].includes(event.kind) && await isReconcileNativeMutation(event.nativeId, event.kind === 'removed' ? event.removal.node?.dateAdded : undefined)) return;
    if (event.kind === 'moved' && await isManagedContentMove(event.nativeId, event.move.parentId, event.move.oldParentId)) return;
    if (event.kind === 'changed' || event.kind === 'moved') {
      await sourceLayout.nativeChanged([event.nativeId], false);
      await settleLocalTransferOwnership(siteLedger.db, [event.nativeId], false, nativeFolderLookup);
    }
    if (event.kind === 'removed') {
      const ids = [event.nativeId];
      const add = (n: { id: string; children?: readonly { id: string }[] }) => { ids.push(n.id); for (const child of n.children ?? []) add(child); };
      if (event.removal.node) add(event.removal.node);
      await sourceLayout.nativeChanged(ids, true);
      await settleLocalTransferOwnership(siteLedger.db, ids, true, nativeFolderLookup);
    }
    scheduleSourceAlarm(Date.now() + 1000, SITE_RECOVERY_ALARM);
  });
}

export async function assertNoCloudDestinationWork() {
  if (workCoordinator.hasInFlight('classification')) throw new Error('cloudClassificationPending');
  const scope = await currentCaptureScope(); let before: readonly [number, string] | undefined;
  for (;;) {
    const page = await captureStore.listForOwner(scope, before);
    if (page.some(unsettledCloudDestination)) throw new Error('cloudClassificationPending');
    const last = page.at(-1); if (!last || page.length < 50) break; before = [last.createdAt, last.captureId];
  }
}
