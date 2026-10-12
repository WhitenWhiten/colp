import { createQueueBatchRepository } from './sync-state/queue-batch-repository.js';
import { createClassificationRepository } from './sync-state/classification-repository.js';
export {
  DATABASE_NAME, DATABASE_VERSION, LARGE_QUEUE_CONTRACT_SIZE,
} from './sync-state/schema.js';
export { SyncStateError } from './sync-state/types.js';
export type {
  Environment, Lifecycle, SyncScope, ScopeRecord, QueueOperation, JsonValue, JsonObject,
  ReceiptInput, PushSettlement, PullApplyState, NativeCallResult, PersistedNativeCallResult,
  IntentRecord, IntentLiveWorkKind,
  PullPageInput, PullEventInput, EffectPageInput,
  EffectPageDownloadRecord, SyncEnginePhase, DurableSyncEngineState, AckIntentRecord, MappingInput,
  BookmarkEventInput, BookmarkEventRecord, CommitBookmarkEventInput, RecoveryPageInput,
  RecoveryNodeRecord,
  BrowserRootAuthority, ImportRecoveryCode, ImportPlanRecord, ImportNodeRecord, CommitImportPlanInput,
  EnqueueImportNodeInput, BindMountMappingInput, MountBindingRecord, ScopePreviewRecord,
  RemoteDeleteFreezeEntry,
  BootstrapRunRecord, BootstrapAttentionReport, BootstrapAttentionItem, DeletionJournalRecord, FirstRunState, ScopeMountMode, BootstrapMode,
  ColpFolderRole, SpecialFolderRole, MountBindingStatus, RemoteDeletePolicy, RemoteDeleteDecisionState,
  RemoteDeleteAction, WritableScopeKind, RangeTransitionAction, RangeTransitionDecision, MountPauseBaseline,
  RemoteObservationRecord, ScopeCommandPlanRecord, RejoinCompareOutcome,
} from './sync-state/types.js';

import { createReorderRepository } from './sync-state/reorder-repository.js';
import { createAdvancedRepository } from './sync-state/advanced-repository.js';
import { createBatchRepository } from './sync-state/batch-repository.js';
import { createRemoteDeleteRepository } from './sync-state/remote-delete-repository.js';
import { createScopeFactsRepository } from './sync-state/scope-facts-repository.js';
import { createBookmarkEventRepository } from './sync-state/bookmark-event-repository.js';
import { createEngineRepository } from './sync-state/engine-repository.js';
import { createMappingRepository } from './sync-state/mapping-repository.js';
import { createMountRepository } from './sync-state/mount-repository.js';
import { createPullRepository } from './sync-state/pull-repository.js';
import { createQueueRepository } from './sync-state/queue-repository.js';
import { createRecoveryRepository } from './sync-state/recovery-repository.js';
import { createSyncStoreRuntime } from './sync-state/runtime.js';
import { createScopeRepository } from './sync-state/scope-repository.js';
import { createIntentFactsRepository } from './sync-state/intent-facts-repository.js';
import type { StoreOptions } from './sync-state/types.js';

export function createSyncStateStore(options: StoreOptions = {}) {
  const ctx = createSyncStoreRuntime(options);
  const scope = createScopeRepository(ctx);
  const intentFacts = createIntentFactsRepository(ctx);
  const mapping = createMappingRepository(ctx);
  const mounts = createMountRepository(ctx);
  const bookmark = createBookmarkEventRepository(ctx);
  const queue = createQueueRepository(ctx);
  const pull = createPullRepository(ctx);
  const recovery = createRecoveryRepository(ctx);
  const engine = createEngineRepository(ctx);
  const advanced = createAdvancedRepository(ctx);
  const remoteDelete = createRemoteDeleteRepository(ctx);
  const batch = createBatchRepository(ctx);
  const facts = createScopeFactsRepository(ctx);
  return Object.freeze({
    open: ctx.open, close: ctx.close, ...createClassificationRepository(ctx),
    ...createQueueBatchRepository(ctx), ...advanced, ...remoteDelete, ...batch, ...facts, ...createReorderRepository(ctx),
    registerScope: scope.registerScope, getScope: scope.getScope,
    putMapping: mapping.putMapping, deleteMapping: mapping.deleteMapping, listMappings: mapping.listMappings,
    getMappingByNativeId: mapping.getMappingByNativeId, getMappingByColpId: mapping.getMappingByColpId,
    bindMountMapping: mapping.bindMountMapping,
    rebindProvisionalBookmarkIdentity: mapping.rebindProvisionalBookmarkIdentity,
    configureBrowserRoots: mapping.configureBrowserRoots, reconcileBrowserRoots: mapping.reconcileBrowserRoots,
    setBrowserRootStatus: mapping.setBrowserRootStatus,
    putMountBinding: mounts.putMountBinding, replaceMountBindings: mounts.replaceMountBindings,
    listMountBindings: mounts.listMountBindings, getMountBinding: mounts.getMountBinding,
    detachMount: mounts.detachMount, rejoinMount: mounts.rejoinMount,
    putMountPauseBaseline: mounts.putMountPauseBaseline, planRemoteDelete: mounts.planRemoteDelete,
    putScopePreview: mounts.putScopePreview, getScopePreview: mounts.getScopePreview,
    putBootstrapRun: mounts.putBootstrapRun, listBootstrapRuns: mounts.listBootstrapRuns,
    currentBootstrapMode: mounts.currentBootstrapMode, putDeletionJournal: mounts.putDeletionJournal,
    listDeletionJournal: mounts.listDeletionJournal, bumpBoundaryVersion: mounts.bumpBoundaryVersion,
    setFirstRun: mounts.setFirstRun, hasActiveMounts: mounts.hasActiveMounts,
    stageBookmarkEvent: bookmark.stageBookmarkEvent, listBookmarkEvents: bookmark.listBookmarkEvents,
    listBookmarkEventsByStatus: bookmark.listBookmarkEventsByStatus,
    listBookmarkEventsByOperation: bookmark.listBookmarkEventsByOperation,
    listBookmarkEventsByNative: bookmark.listBookmarkEventsByNative, getBookmarkEvent: bookmark.getBookmarkEvent,
    discardAppliedRemoteDeleteEcho: bookmark.discardAppliedRemoteDeleteEcho,
    compactScope: bookmark.compactScope, commitBookmarkEvent: bookmark.commitBookmarkEvent,
    putIngressDiagnostic: bookmark.putIngressDiagnostic, listIngressDiagnostics: bookmark.listIngressDiagnostics,
    pruneParkDiagnostics: bookmark.pruneParkDiagnostics,
    allocateSequenceAndEnqueue: queue.allocateSequenceAndEnqueue,
    advanceSequenceFloor: queue.advanceSequenceFloor, listQueue: queue.listQueue,
    listQueueByTarget: queue.listQueueByTarget,
    getQueueByOpId: queue.getQueueByOpId,
    getQueueReceipt: queue.getQueueReceipt,
    commitImportPlan: engine.commitImportPlan, listImportPlans: engine.listImportPlans,
    listImportNodes: engine.listImportNodes, setImportPlanState: engine.setImportPlanState,
    setImportNodeRecovery: engine.setImportNodeRecovery, retryImportNode: engine.retryImportNode,
    enqueueImportNode: engine.enqueueImportNode,
    completeQueueWithReceipt: queue.completeQueueWithReceipt,
    completeClaimedQueueWithReceipt: queue.completeClaimedQueueWithReceipt,
    publishCursor: queue.publishCursor, createApplyIntent: pull.createApplyIntent,
    findApplyIntent: pull.findApplyIntent, getApplyIntent: pull.getApplyIntent,
    listApplyIntents: intentFacts.listApplyIntents, persistApplyIntentFacts: intentFacts.persistApplyIntentFacts,
    hasActiveApplyIntentForNativeTarget: pull.hasActiveApplyIntentForNativeTarget,
    commitApplyIntent: pull.commitApplyIntent,
    stagePullPage: pull.stagePullPage, listPullEvents: pull.listPullEvents,
    listPullEventsByPage: pull.listPullEventsByPage,
    hasPullEventsAwaitingConfirmation: pull.hasPullEventsAwaitingConfirmation, getPullEvent: pull.getPullEvent,
    listPullPages: pull.listPullPages, loadPullApplyWorkset: pull.loadPullApplyWorkset, prunePullHistory: pull.prunePullHistory,
    pullOperationsCovered: pull.pullOperationsCovered, getCursor: pull.getCursor, listAckIntents: engine.listAckIntents,
    hasRecoveryStaging: recovery.hasRecoveryStaging,
    getRecoveryHeader: recovery.getRecoveryHeader, listRecoveryNodes: recovery.listRecoveryNodes,
    preparePullIntent: pull.preparePullIntent, markPullBrowserCallStarted: pull.markPullBrowserCallStarted,
    observeApplyIntentEvent: pull.observeApplyIntentEvent,
    observeApplyIntentPostState: pull.observeApplyIntentPostState,
    observeApplyIntentChangeFields: pull.observeApplyIntentChangeFields,
    recordPullApiEvidence: pull.recordPullApiEvidence, commitPullEvent: pull.commitPullEvent,
    completePullPage: pull.completePullPage,
    stageRecoveryPage: recovery.stageRecoveryPage, discardRecoveryStaging: recovery.discardRecoveryStaging,
    finalizeRecoveryMappings: recovery.finalizeRecoveryMappings, commitRecovery: recovery.commitRecovery,
    rebaseRecoveryCursor: recovery.rebaseRecoveryCursor,
    rebaseActiveSessionAuthority: recovery.rebaseActiveSessionAuthority,
    putEffectDownload: pull.putEffectDownload, getEffectDownload: pull.getEffectDownload,
    clearEffectDownload: pull.clearEffectDownload, putScopeDiagnostic: pull.putScopeDiagnostic,
    replaceProjectionIntents: pull.replaceProjectionIntents, listProjectionIntents: pull.listProjectionIntents,
    settleProjectionIntent: pull.settleProjectionIntent,
    getEngineState: engine.getEngineState, transitionEngine: engine.transitionEngine,
    claimRestartConnectivity: engine.claimRestartConnectivity,
    confirmRestartConnectivity: engine.confirmRestartConnectivity, beginAckIntent: engine.beginAckIntent,
    getPendingAckIntent: engine.getPendingAckIntent, completeAckIntent: engine.completeAckIntent,
    rejectBootstrapAckAndRequireAuthorityRefresh: engine.rejectBootstrapAckAndRequireAuthorityRefresh,
    discardPullAckIntent: engine.discardPullAckIntent,
    acquireLease: queue.acquireLease, renewLease: queue.renewLease, claimQueue: queue.claimQueue, claimNextQueue: queue.claimNextQueue,
    realignQueueAfterGap: queue.realignQueueAfterGap, bindPushAttempt: queue.bindPushAttempt,
    rebaseClaimedPush: queue.rebaseClaimedPush, settleClaimedPush: queue.settleClaimedPush,
    repairSequenceReuseRow: queue.repairSequenceReuseRow,
    retireScope: scope.retireScope, cleanupAccount: scope.cleanupAccount, exportScope: scope.exportScope,
    exportArchive: scope.exportArchive, peekDurableCache: scope.peekDurableCache,
    importPreformalBinding: scope.importPreformalBinding, seedLegacyForMigration: scope.seedLegacyForMigration,
    exportLegacyDiagnostic: scope.exportLegacyDiagnostic, injectCorruptionForTest: scope.injectCorruptionForTest,
    auditIntegrity: scope.auditIntegrity, exportDiagnostics: scope.exportDiagnostics,
  });
}
