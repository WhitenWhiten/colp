import { resumeSnapshotDeferredCreate } from './pull-native-snapshot-resume.js';
import { finishReadyPullPages } from './pull-page-completion.js';
import { exceedsSyncIssueCeiling } from './sync-issue-ceiling.js';
import { remoteDeleteDeferral, remoteDeleteDeferralMatches } from './remote-delete-pending-facts.js';
import { SyncFailureError } from './sync-failure-class.js';
import { setAsideFailedPullItem, setAsidePullItem } from './pull-item-set-aside.js';
import { createPullBookmarkEvidence, readOptional } from './pull-bookmark-evidence.js';
import { parentRevisionMappingFor } from './pull-child-order.js';
import { createExpectation, executePullNativeCreate, recoverCreatedNative, sidecarExpectation } from './pull-create-evidence.js';
import { applyRemoteDeletion } from './pull-delete-apply.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { JsonObject, JsonValue, MappingInput, RemoteObservationRecord } from './sync-state-store.js';
import type { NativeEvent, PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import { SyncStateError } from './sync-state/types.js';
import { digest } from './pull-codec.js';
import { chromeCreate, mappingFor, nativeContent, nodeContent } from './pull-projection.js';
import { ordinaryPullEventAllowed, publishSupersededPullMappings, readPullApplyAuthority,
  recoverSupersededPullEvent } from './pull-authority-apply.js';
import { assertPullApplierGate } from './pull-page-stager.js';
import { freezePullApply, withPullFreeze } from './pull-recovery-freeze.js';
import { bindMountMappings, boundNativeId, isNonChromeNativeId, isRecoveryPlaceholder,
  bindStructureMapping, isVirtualNativeId, mayMutateNative, persistMountBinding, planCreated, planRestored,
  unmountedNativeId } from './pull-mount-apply.js';
import { materializeRestoredNode } from './pull-restore-apply.js';
import { advancedSelfProjectionIsProven } from './pull-local-projection-evidence.js';
import { interceptStagedRemoteDelete, settleAppliedRemoteDelete, settleParkedRemoteDeletes } from './remote-delete-apply.js';
import {
  commitMissingTerminalSelfDeletion, commitRemovedSelfProjection, missingTerminalSelfDeletion, preflightPullDependencies,
  preflightPullMapping, requirePullMapping,
} from './pull-apply-decision.js';
import {
  applyPlannedMove, frozenRangeAction, moveAnchors, planRemoteMove,
  rangeActionOf, rangePlanFromAnchors, resolvePersistedMovePlan, type PlannedMoveApply,
} from './pull-range-move.js';
import { pendingLocalContentForEvent, queueHasPendingTarget } from './pull-queue-facts.js';
import { applyRemoteNodeContentUpdate } from './pull-native-content-barrier.js';
import { kns09Paused, recordKns09Stop } from './kns-09-release.js';
import { pauseBindingForMapping } from './sync-state/remote-observation.js';
import { hasQueuedSelfCreate, provisionalSelfCreateMapping } from './pull-self-create.js';
import { commitSupersededByLocalDelete } from './pull-local-delete-supersede.js';
import { logBackgroundFailure } from './sw/background-failure.js';
import { nativeWritePreimage, recordUnstartedPullRefusal } from './pull-native-write-boundary.js';
import { createCheckedPullNative } from './pull-native-create-boundary.js';

const INTENT_TTL_MS = 5 * 60_000;

export function createPullApplyRuntime(options: PullApplierOptions, api: PullBookmarkApi,
  now: () => number) {
  const parentRevisionMapping = parentRevisionMappingFor(options);
  async function preflight(event: Extract<SyncPullEventV02, { kind: 'operation' }>, stagedCreates: ReadonlySet<string>): Promise<void> {
    await preflightPullDependencies(options, event, stagedCreates, selfCreateProjection, lookup);
  }
  async function requireMapping(colpId: string, role: 'anchor' | 'deletion' | 'parent' | 'parent_revision' | 'target') {
    return requirePullMapping(options, colpId, role);
  }
  async function preflightMapping(colpId: string, stagedCreates: ReadonlySet<string>,
    role: 'member' | 'parent' | 'target') {
    return preflightPullMapping(options, colpId, stagedCreates, role);
  }
  async function resume(mode: { readonly recoveryOnly?: boolean } = {}): Promise<void> { await withPullFreeze(options, () => resumeApply(mode)); }

  // SR-02 read seam: classification, diagnostics and anchor indexing live in
  // `pull-bookmark-evidence.ts` so this file never reads Chrome state unclassified.
  const { lookup, targetMissingError, parentChildren, nativeIndex } = createPullBookmarkEvidence(options, api);

  async function resumeApply(mode: { readonly recoveryOnly?: boolean }): Promise<void> {
    assertPullApplierGate(options);
    if (await kns09Paused('pull')) throw new SyncFailureError('sync_paused');
    await options.store.resumeNativeWaitDependents(options.scope);
    await settleParkedRemoteDeletes(options, now);
    await options.store.resumeRemoteDeleteDependents(options.scope);
    const authority = await readPullApplyAuthority(options);
    const events = await options.store.listPullEvents(options.scope,
      ['staged', 'intent_prepared', 'browser_call_started', 'native_event_observed', 'authority_committed']);
    if (events.some(event => event.state !== 'authority_committed')
      && (authority.lifecycle === 'recovery_required' || (authority.frozen && authority.lifecycle !== 'active'))) {
      throw new SyncFailureError('recovery_required');
    }
    for (const raw of events) {
      if (raw.state === 'authority_committed') continue;
      if ((mode.recoveryOnly || await exceedsSyncIssueCeiling(options.store, options.scope))
          && ['staged', 'intent_prepared'].includes(String(raw.state))) continue;
      const decisionId = remoteDeleteDeferral(raw);
      const decision = decisionId ? await options.store.getRemoteDeleteDecision(options.scope, decisionId) : undefined;
      const detached = (remoteDeleteDeferralMatches(raw, decision ?? undefined, options.scope.generation)
        || await options.store.isPullDeferral(options.scope, String(raw.eventId)))
        && authority.lifecycle === 'active' && !authority.frozen;
      if (!ordinaryPullEventAllowed(authority, raw) && !detached) { await recoverSupersededPullEvent(options, authority, raw); continue; }
      const event = raw.payload as unknown as Extract<SyncPullEventV02, { kind: 'operation' }>;
      try {
      if (await commitRemovedSelfProjection(options, String(raw.eventId), event, now(), parentRevisionMapping)
        || await commitSupersededByLocalDelete(options, String(raw.eventId), event, now())) continue;
      if (raw.state === 'staged') {
        if (await setAsidePullItem(options, String(raw.eventId), event, now())) continue;
        if (await interceptStagedRemoteDelete(options, api, String(raw.eventId), String(raw.pageId), event, now) === 'skip') continue;
        options.crash?.('before_intent'); await prepare(raw.eventId as string, event);
      }
      options.crash?.('after_intent');
      // F036: a row listed above but gone here is a local integrity fault. Name
      // it explicitly so it cannot masquerade as network unavailability.
      const current = await options.store.getPullEvent(options.scope, raw.eventId as string);
      if (!current) throw new SyncStateError('pull_event_state_invalid');
      const createLike = event.effect.kind === 'node_created' || event.effect.kind === 'node_restored';
      if (current.state === 'intent_prepared' && !createLike && event.effect.kind !== 'node_moved') {
        await options.store.markPullBrowserCallStarted(options.scope, raw.eventId as string);
      }
      if ((current.state === 'browser_call_started' || current.state === 'native_event_observed') && createLike) {
        // onCreated correlation is a candidate only. Both states must use the
        // executor's API receipt / explicit user-confirmation classification.
        await recoverUncertainCreate(event);
      } else if (current.state === 'browser_call_started' || current.state === 'native_event_observed') {
        await recoverPostState(raw.eventId as string, event);
      }
      else await callAndCommit(raw.eventId as string, event);
      } catch (error) {
        await recordUnstartedPullRefusal(options, raw, event.effect.kind, error);
        // B5: a failure about this event's own node sets that node aside; the page goes on.
        if (!await setAsideFailedPullItem(options, raw, event, error, now())) throw error;
      }
    }
    await publishSupersededPullMappings(options, authority);
    await finishReadyPullPages(options, authority, now());
  }

  async function prepare(eventId: string, event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    const expectation = await expected(event); const correlationId = digest({ kind: expectation.eventKind,
      nativeId: expectation.nativeId, details: 'correlationDetails' in expectation
        ? expectation.correlationDetails : expectation.details });
    await options.store.preparePullIntent(options.scope, eventId, { intentId: `intent:${eventId}`, correlationId,
      operationId: event.operation.opId, eventId, effectId: event.effect.effectId, state: 'intent_prepared',
      expected: { kind: expectation.eventKind, nativeId: expectation.nativeId || `pending:${event.effect.effectId}` },
      expiresAt: now() + INTENT_TTL_MS,
      preStateDigest: expectation.preStateDigest, expectedPostState: { digest: digest(
        'correlationDetails' in expectation ? expectation.correlationDetails : expectation.details),
      ...(expectation.eventKind === 'change' && 'correlationDetails' in expectation
        ? { nativeContent: expectation.correlationDetails } : {}) },
      nativeTargetId: expectation.nativeId || null, nativeParentId: expectation.parentNativeId ?? null,
      anchors: expectation.anchors, apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null,
      generation: options.scope.generation });
  }

  async function expected(event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    const effect = event.effect;
    if (await missingTerminalSelfDeletion(options, event)) return { eventKind: 'remove' as const, nativeId: '',
      details: { recovery: 'self_echo' }, anchors: {}, preStateDigest: digest(null) };
    if (effect.kind === 'node_created' || effect.kind === 'node_restored') return expectedCreateLike(event);
    const colpId = effect.kind === 'node_deleted' ? effect.tombstone.targetId
      : effect.kind === 'subtree_deleted' ? effect.rootTombstone.targetId : effect.node.id;
    if (effect.kind === 'subtree_deleted' && !await options.store.getMappingByColpId(options.scope, colpId)) {
      return sidecarExpectation(effect.effectDigest, { colpId, nativeId: unmountedNativeId(colpId),
        rootNativeId: unmountedNativeId(colpId), projection: { revision: 'deleted', digest: effect.effectDigest } });
    }
    const mapping = await requireMapping(colpId, 'target');
    const mounts = await options.store.listMountBindings(options.scope);
    if (effect.kind !== 'node_moved' && !mayMutateNative(mapping, mounts)) {
      return sidecarExpectation(effect.effectDigest, mapping);
    }
    if (effect.kind === 'node_content_updated') {
      // SR-02: `not_found` here is not transport noise - the target of the remote update is gone
      // locally (deleted outside sync), so no local mutation can express the remote post-state.
      const looked = await lookup(mapping.nativeId);
      if (looked.class === 'not_found') throw await targetMissingError(effect.node.id, mapping.nativeId);
      if (looked.class !== 'present') throw new Error(looked.message);
      const current = looked.nodes[0]; const finalContent = { ...nodeContent(effect.node), ...await pendingLocalContentForEvent(options.store, options.scope, mapping, event) };
      const details = Object.fromEntries(Object.entries(finalContent).filter(([key, value]) => current?.[key as 'title' | 'url'] !== value));
      return { eventKind: 'change', nativeId: mapping.nativeId, details, correlationDetails: finalContent, anchors: {},
        preStateDigest: mapping.projection.digest };
    }
    if (effect.kind === 'node_moved') { const parent = await requireMapping(effect.placement.parentId, 'parent');
      const plan = planRemoteMove({ event, mapping, parent, mounts, generation: options.scope.generation,
        permissionConfirmed: (await options.store.getScope(options.scope))?.rootStatus !== 'permission_required',
        pendingLocalOperations: await queueHasPendingTarget(options.store, options.scope, mapping.colpId) });
      if (plan.action === 'await_dependency') throw new SyncFailureError('range_dependency_pending');
      const index = plan.chromeMutation
        ? await nativeIndex(effect.placement.afterId, effect.placement.beforeId) : 0;
      if (plan.action === 'materialize_independent') {
        const expectation = createExpectation(effect, parent.nativeId, index,
          await parentChildren(effect.placement.parentId, parent.nativeId));
        return { ...expectation, anchors: moveAnchors(plan, expectation.anchors) };
      }
      // Reading the current node is "what do we know about the source", not "it must exist":
      // a vanished source still has its stored parent/index for `oldParentId`/`oldIndex`, so
      // `not_found` degrades to `before === undefined`. Genuine API faults still surface.
      const before = readOptional(isNonChromeNativeId(mapping.nativeId) ? undefined : await lookup(mapping.nativeId));
      if (!plan.chromeMutation) {
        return { ...sidecarExpectation(effect.effectDigest, mapping, parent.nativeId),
          anchors: moveAnchors(plan, { afterId: effect.placement.afterId, beforeId: effect.placement.beforeId }) };
      }
      return { eventKind: 'move', nativeId: mapping.nativeId, parentNativeId: parent.nativeId,
        details: { parentId: parent.nativeId, index, oldParentId: before?.parentId ?? mapping.parentNativeId ?? '',
          oldIndex: before?.index ?? 0 }, anchors: moveAnchors(plan, { afterId: effect.placement.afterId,
          beforeId: effect.placement.beforeId, index, ...(before ? { nativePreimage: nativeWritePreimage(before) } : {}) }), preStateDigest: mapping.projection.digest }; }
    const looked = isVirtualNativeId(mapping.nativeId) ? { class: 'not_found' as const } : await lookup(mapping.nativeId);
    if (looked.class === 'permission_denied' || looked.class === 'managed_not_writable'
      || looked.class === 'other_failure') {
      throw new Error(looked.message);
    }
    const before = looked.class === 'present' ? looked.nodes[0] : undefined;
    return { eventKind: 'remove', nativeId: mapping.nativeId,
      details: { parentId: before?.parentId ?? mapping.parentNativeId ?? '', index: before?.index ?? 0 }, anchors: {},
      preStateDigest: mapping.projection.digest };
  }

  async function expectedCreateLike(event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    const effect = event.effect;
    if (effect.kind !== 'node_created' && effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
    if (effect.kind === 'node_created') {
      const plan = await planCreated(options.store, options.scope, event, lookup);
      if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
      if (plan.kind === 'skip_unmounted') {
        return { eventKind: 'sidecar' as const, nativeId: unmountedNativeId(effect.node.id),
          parentNativeId: unmountedNativeId(effect.placement.parentId), details: { effectDigest: effect.effectDigest },
          anchors: {}, preStateDigest: digest(null) };
      }
      if (plan.kind === 'bind_structure') return { eventKind: 'sidecar' as const, nativeId: plan.mapping.nativeId,
        parentNativeId: plan.mapping.parentNativeId ?? plan.mapping.nativeId, details: { effectDigest: effect.effectDigest }, anchors: {}, preStateDigest: digest(null) };
      if (plan.kind === 'bind_mount') {
        return { eventKind: 'sidecar' as const, nativeId: plan.mount.nativeRootId, parentNativeId: plan.mount.nativeRootId,
          details: { effectDigest: effect.effectDigest }, anchors: {}, preStateDigest: digest(null) };
      }
      if (plan.kind === 'recovered_folder') {
        // Same evidence rule as the general create path: the recovered mount root is expected to
        // exist, so a vanished one is a divergence and a read fault must not become an empty digest.
        return createExpectation(effect, plan.mount.nativeRootId, 0,
          await parentChildren(effect.placement.parentId, plan.mount.nativeRootId));
      }
    } else {
      const plan = await planRestored(options.store, options.scope, effect.placement.parentId);
      if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
      if (plan.kind === 'skip_unmounted') {
        return { eventKind: 'sidecar' as const, nativeId: unmountedNativeId(effect.node.id),
          parentNativeId: unmountedNativeId(effect.placement.parentId), details: { effectDigest: effect.effectDigest },
          anchors: {}, preStateDigest: digest(null) };
      }
    }
    const parent = await requireMapping(effect.placement.parentId, 'parent');
    if (effect.kind === 'node_created' && event.operation.replicaId === options.scope.replicaId) {
      const existing = await options.store.getMappingByColpId(options.scope, effect.node.id);
      const own = await options.store.getQueueByOpId(options.scope, event.operation.opId);
      if (existing && !isNonChromeNativeId(existing.nativeId) && own?.status === 'terminal'
          && own.payload.type === 'create_node') {
        const proven = await selfCreateProjection(event, existing, parent);
        return sidecarExpectation(effect.effectDigest, proven, parent.nativeId);
      }
      const provisional = existing ? null : await provisionalSelfCreateMapping(options, event, parent);
      if (provisional) {
        const proven = await selfCreateProjection(event, provisional, parent);
        return sidecarExpectation(effect.effectDigest, proven, parent.nativeId);
      }
    }
    const index = await nativeIndex(effect.placement.afterId, effect.placement.beforeId);
    if (effect.node.kind === 'separator' && options.session.conversionPolicy?.separator === 'preserve_remote') {
      return { eventKind: 'sidecar' as const, nativeId: `sidecar:${effect.node.id}`, parentNativeId: parent.nativeId,
        details: { effectDigest: effect.effectDigest }, anchors: { afterId: effect.placement.afterId,
          beforeId: effect.placement.beforeId, index },
        preStateDigest: digest(await parentChildren(effect.placement.parentId, parent.nativeId)) };
    }
    return createExpectation(effect, parent.nativeId, index,
      await parentChildren(effect.placement.parentId, parent.nativeId));
  }

  async function applyRestored(eventId: string, event: Extract<SyncPullEventV02, { kind: 'operation' }>): Promise<{
    readonly mappings: MappingInput[]; readonly deleteNativeIds: readonly string[];
    readonly observations: readonly Omit<RemoteObservationRecord, 'scopeKey'>[] }> {
    return materializeRestoredNode({ eventId, event, store: options.store, api, options, scope: options.scope,
      generation: options.scope.generation, separatorPolicy: options.session.conversionPolicy?.separator,
      now, nativeIndex, parentRevisionMapping: revision => parentRevisionMapping(revision, event) });
  }

  async function callAndCommit(eventId: string, event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    if (await commitRemovedSelfProjection(options, eventId, event, now(), parentRevisionMapping)) return;
    options.crash?.('before_event'); const effect = event.effect; const mappings: MappingInput[] = []; const deleteNativeIds: string[] = [];
    if (await missingTerminalSelfDeletion(options, event)) {
      await commitMissingTerminalSelfDeletion(options, eventId, event, revision => parentRevisionMapping(revision, event)); return; }
    const mounts = await options.store.listMountBindings(options.scope);
    const observations: Omit<RemoteObservationRecord, 'scopeKey'>[] = [];
    let rangeExit: PlannedMoveApply['rangeExit'];
    if (effect.kind === 'node_restored') {
      const applied = await applyRestored(eventId, event);
      mappings.push(...applied.mappings); deleteNativeIds.push(...applied.deleteNativeIds);
      const restoredMapping = applied.mappings[0];
      observations.push(...applied.observations.map((row) => restoredMapping
        ? { ...row, ...pauseBindingForMapping(restoredMapping, mounts) } : row));
    } else if (effect.kind === 'node_created') {
      const plan = await planCreated(options.store, options.scope, event, lookup);
      if (plan.kind === 'bind_structure') {
        mappings.push(bindStructureMapping(effect.node, plan.mapping, effect.placement.parentId, effect.nodeChildrenRevision));
      } else if (plan.kind === 'bind_mount') {
        await persistMountBinding(options.store, options.scope, plan.mount, effect.node.id);
        mappings.push(await bindMountMappings(effect.node, plan.mount, effect.placement.parentId,
          effect.nodeChildrenRevision));
      } else if (plan.kind === 'need_authority') {
        throw new SyncFailureError('need_authority');
      } else if (plan.kind === 'skip_unmounted') {
        mappings.push(mappingFor(effect.node, unmountedNativeId(effect.node.id),
          unmountedNativeId(effect.placement.parentId), effect.placement.parentId, effect.nodeChildrenRevision,
          unmountedNativeId(effect.placement.parentId)));
      } else if (plan.kind === 'recovered_folder') {
        const outcome = await executePullNativeCreate(options, api, event, plan.mount.nativeRootId, eventId, async () =>
          createCheckedPullNative({ ...options, api, parentColpId: plan.mount.remoteMountNodeId!, placement: effect.placement,
            expectedBoundaryVersion: plan.mount.boundaryVersion, details: { parentId: plan.mount.nativeRootId,
              index: await nativeIndex(effect.placement.afterId, effect.placement.beforeId), ...chromeCreate(effect.node) } }));
        if (outcome.result !== 'applied_with_evidence') throw new Error(outcome.result === 'failed' ? outcome.code : 'native_result_unknown');
        mappings.push(mappingFor(effect.node, outcome.nativeId, plan.mount.nativeRootId, plan.mount.remoteMountNodeId,
          effect.nodeChildrenRevision, plan.mount.nativeRootId));
      } else {
      const existing = await options.store.getMappingByColpId(options.scope, effect.node.id);
      const provisional = existing ? null : await provisionalSelfCreateMapping(options, event,
        await requireMapping(effect.placement.parentId, 'parent'));
      if (provisional) {
        const parent = await requireMapping(effect.placement.parentId, 'parent');
        mappings.push(await selfCreateProjection(event, provisional, parent));
      } else if (existing && !isRecoveryPlaceholder(existing.nativeId)
          && event.operation.replicaId === options.scope.replicaId) {
        mappings.push(await selfCreateProjection(event, existing, await requireMapping(effect.placement.parentId, 'parent')));
      } else if (effect.node.kind === 'separator' && options.session.conversionPolicy?.separator !== 'native') {
        if (options.session.conversionPolicy?.separator !== 'preserve_remote') throw new SyncFailureError('separator_conversion_blocked');
        const parent = await requireMapping(effect.placement.parentId, 'parent');
        mappings.push(mappingFor(effect.node, `sidecar:${effect.node.id}`, parent.nativeId, parent.colpId,
          effect.nodeChildrenRevision, parent.rootNativeId));
      } else {
        const parent = await requireMapping(effect.placement.parentId, 'parent'); const parentNative = boundNativeId(parent, mounts);
        const parentRoot = isRecoveryPlaceholder(parent.rootNativeId) ? parentNative : parent.rootNativeId;
        const outcome = await executePullNativeCreate(options, api, event, parentNative, eventId, async () =>
          createCheckedPullNative({ ...options, api, parent, parentColpId: parent.colpId, placement: effect.placement,
            details: { parentId: parentNative, index: await nativeIndex(effect.placement.afterId, effect.placement.beforeId), ...chromeCreate(effect.node) } }));
        if (outcome.result !== 'applied_with_evidence') {
          throw new Error(outcome.result === 'failed' ? outcome.code : 'native_result_unknown');
        }
        const occupied = await options.store.getMappingByNativeId(options.scope, outcome.nativeId);
        if (occupied && occupied.colpId !== effect.node.id) {
          recordKns09Stop('mappingIdentityCollision', options.scope);
          await enterRecoveryRequired('mapping_identity_collision'); throw new SyncFailureError('recovery_required');
        }
        mappings.push(mappingFor(effect.node, outcome.nativeId, parentNative, parent.colpId,
          effect.nodeChildrenRevision, parentRoot));
        if (existing && isRecoveryPlaceholder(existing.nativeId)) deleteNativeIds.push(existing.nativeId);
      }
      }
      mappings.push(await parentRevisionMapping(effect.parentRevision, event, mappings[0]?.nativeId));
    } else if (effect.kind === 'node_content_updated') {
      const mapping = await requireMapping(effect.node.id, 'target');
      const applied = await applyRemoteNodeContentUpdate({
        store: options.store, scope: options.scope, api, mapping, node: effect.node,
        effectDigest: effect.effectDigest, eventId, mounts, now, lookup, targetMissingError,
        queuedLocal: await pendingLocalContentForEvent(options.store, options.scope, mapping, event),
      });
      mappings.push(applied.mapping);
      if (applied.rangeExit) rangeExit = applied.rangeExit;
    } else if (effect.kind === 'node_moved') {
      const mapping = await requireMapping(effect.node.id, 'target');
      const parent = await requireMapping(effect.placement.parentId, 'parent');
      const current = planRemoteMove({ event, mapping, parent, mounts, generation: options.scope.generation,
        permissionConfirmed: (await options.store.getScope(options.scope))?.rootStatus !== 'permission_required',
        pendingLocalOperations: await queueHasPendingTarget(options.store, options.scope, mapping.colpId) });
      const intent = await options.store.getApplyIntent(options.scope, `intent:${eventId}`);
      const plan = resolvePersistedMovePlan(rangePlanFromAnchors(intent?.anchors, `rx:${event.operation.opId}`), current);
      if (plan.action !== 'materialize_independent') {
        const live = await options.store.getPullEvent(options.scope, eventId);
        if (live?.state === 'intent_prepared') {
          await options.store.markPullBrowserCallStarted(options.scope, eventId);
        }
      }
      const applied = await applyPlannedMove({
        store: options.store, scope: options.scope, api, event, mapping, parent, plan, now: now(),
        eventId, crash: options.crash,
        permissionGranted: (await options.store.getScope(options.scope))?.rootStatus !== 'permission_required',
        cursor: String((await options.store.getPullEvent(options.scope, eventId))?.cursor ?? '0'),
        nativeIndex, parentRevisionMapping: revision => parentRevisionMapping(revision, event),
        recoverCreated: async () => executePullNativeCreate(options, api, event, parent.nativeId,
          `${event.cursor}:${event.operation.opId}`, async () => createCheckedPullNative({ ...options, api, parent,
            parentColpId: parent.colpId, placement: effect.placement, expectedBoundaryVersion: plan.destBoundaryVersion ?? undefined,
            details: { parentId: parent.nativeId, index: await nativeIndex(effect.placement.afterId, effect.placement.beforeId), ...chromeCreate(effect.node) } })),
      });
      mappings.push(...applied.mappings); deleteNativeIds.push(...applied.deleteNativeIds);
      if (applied.observations) observations.push(...applied.observations);
      rangeExit = applied.rangeExit;
    } else if (effect.kind === 'node_deleted' || effect.kind === 'subtree_deleted') {
      const applied = await applyRemoteDeletion({
        store: options.store, scope: options.scope, event, eventId, mounts, api, requireMapping, now: now(),
        crash: options.crash, parentRevisionMapping: revision => parentRevisionMapping(revision, event),
      });
      deleteNativeIds.push(...applied.deleteNativeIds); observations.push(...applied.observations);
      mappings.push(...applied.mappings);
      if (applied.rangeExit) rangeExit = applied.rangeExit;
    } else throw new SyncFailureError('pull_effect_kind_invalid');
    const live = await options.store.getPullEvent(options.scope, eventId);
    if (live?.state === 'intent_prepared') {
      await options.store.markPullBrowserCallStarted(options.scope, eventId);
    }
    const confirmed = await options.store.getApplyIntent(options.scope, `intent:${eventId}`);
    if (confirmed?.nativeResultConfirmation?.kind !== 'candidate_event') {
      await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId,
      ...((effect.kind === 'node_created' || effect.kind === 'node_restored' || effect.kind === 'node_moved')
        && mappings[0] ? { nativeId: mappings[0].nativeId } : {}),
      resultDigest: digest({ mappings: mappings.map((mapping) => mapping.nativeId), deleteNativeIds }) });
    }
    options.crash?.('after_browser_call');
    options.crash?.('after_api_evidence');
    await options.store.commitPullEvent(options.scope, eventId, { mappings, deleteNativeIds, observations,
      apiResultEvidence: { operationId: event.operation.opId, effectDigest: event.effect.effectDigest },
      ...(rangeExit ? { rangeExit } : {}) });
    await settleAppliedRemoteDelete(options, eventId, event, now);
    options.crash?.('after_event');
  }

  async function selfCreateProjection(event: Extract<SyncPullEventV02, { kind: 'operation' }>,
    existing: MappingInput, parent: MappingInput): Promise<MappingInput> {
    const effect = event.effect;
    if (effect.kind !== 'node_created' && effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
    const expectedNode = chromeCreate(effect.node);
    // Verification read, not an existence expectation: a vanished native must reach the existing
    // `native === undefined` branch (which then proves or refuses the self projection), while a
    // genuine API fault still surfaces instead of masquerading as "not proven".
    let native = readOptional(isVirtualNativeId(existing.nativeId) ? undefined : await lookup(existing.nativeId));
    let exact = isVirtualNativeId(existing.nativeId)
      ? effect.node.kind === 'separator' && options.session.conversionPolicy?.separator === 'preserve_remote'
      : native?.parentId === parent.nativeId && native.title === expectedNode.title && native.url === expectedNode.url;
    if (!exact && options.settleNativeEvents) {
      // Chrome can expose the edited node before its callback has finished journalling it.
      await options.settleNativeEvents();
      native = readOptional(isVirtualNativeId(existing.nativeId) ? undefined : await lookup(existing.nativeId));
      exact = native?.parentId === parent.nativeId && native.title === expectedNode.title && native.url === expectedNode.url;
    }
    // Receipts and native callbacks can advance the mapping while the reads above yield.
    existing = await options.store.getMappingByColpId(options.scope, existing.colpId) ?? existing;
    let advanced = !exact && await advancedSelfProjectionIsProven(options.store, options.scope,
      existing, native, parent.nativeId, event.operation.sequence);
    const priorIndex = parent.projection.childrenOrder?.indexOf(existing.nativeId);
    const orderChanged = native?.parentId === parent.nativeId && priorIndex !== undefined && priorIndex >= 0
      && native.index !== priorIndex;
    if ((!exact && !advanced || orderChanged) && !isVirtualNativeId(existing.nativeId) && options.repairOwnCreate
        && await hasQueuedSelfCreate(options, event)) {
      await options.repairOwnCreate(existing, parent);
      native = readOptional(await lookup(existing.nativeId));
      exact = native?.parentId === parent.nativeId && native.title === expectedNode.title && native.url === expectedNode.url;
      advanced = !exact && await advancedSelfProjectionIsProven(options.store, options.scope,
        existing, native, parent.nativeId, event.operation.sequence);
    }
    if (!exact && !advanced) { await enterRecoveryRequired('create_ambiguous'); throw new SyncFailureError('recovery_required'); }
    const { scopeKey: _scopeKey, ...currentMapping } = existing as MappingInput & { readonly scopeKey?: string };
    return advanced ? currentMapping : mappingFor(effect.node, existing.nativeId, parent.nativeId, parent.colpId,
      effect.kind === 'node_created' ? effect.nodeChildrenRevision : null, parent.rootNativeId);
  }

  async function recoverUncertainCreate(event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    const effect = event.effect;
    if (effect.kind !== 'node_created' && effect.kind !== 'node_restored') return;
    const existing = await options.store.getMappingByColpId(options.scope, effect.node.id);
    const provisional = existing ? null : await provisionalSelfCreateMapping(options, event,
      await requireMapping(effect.placement.parentId, 'parent'));
    if (provisional) {
      const eventKey = `${event.cursor}:${event.operation.opId}`;
      const parent = await requireMapping(effect.placement.parentId, 'parent');
      await options.store.recordPullApiEvidence(options.scope, eventKey, { operationId: event.operation.opId,
        nativeId: provisional.nativeId, recovery: 'self_echo' });
      await options.store.commitPullEvent(options.scope, eventKey, { mappings: [
        await selfCreateProjection(event, provisional, parent),
        await parentRevisionMapping(effect.parentRevision, event, provisional.nativeId)],
      apiResultEvidence: { operationId: event.operation.opId, recovery: 'self_echo' } });
      return;
    }
    if (existing && !isRecoveryPlaceholder(existing.nativeId)
        && event.operation.replicaId === options.scope.replicaId) {
      const mapping = await selfCreateProjection(event, existing, await requireMapping(effect.placement.parentId, 'parent'));
      const eventId = `${event.cursor}:${event.operation.opId}`;
      await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId,
        nativeId: existing.nativeId, recovery: 'self_echo' });
      await options.store.commitPullEvent(options.scope, eventId, { mappings: [mapping,
      await parentRevisionMapping(effect.parentRevision, event)], apiResultEvidence: {
        operationId: event.operation.opId, recovery: 'self_echo' } });
      return;
    }
    if (effect.node.kind === 'separator' && options.session.conversionPolicy?.separator === 'preserve_remote') {
      await callAndCommit(`${event.cursor}:${event.operation.opId}`, event); return;
    }
    const parent = await requireMapping(effect.placement.parentId, 'parent').catch((error: unknown) => {
      if (effect.kind === 'node_restored') return null;
      throw error;
    });
    if (!parent) { await callAndCommit(`${event.cursor}:${event.operation.opId}`, event); return; }
    const eventKey = `${event.cursor}:${event.operation.opId}`;
    const intent = await options.store.getApplyIntent(options.scope, `intent:${eventKey}`);
    const outcome = await recoverCreatedNative(options, api, event, parent.nativeId, intent, true);
    if (outcome.result !== 'applied_with_evidence') {
      throw new Error(outcome.result === 'failed' ? outcome.code : 'native_result_unknown');
    }
    const nativeId = outcome.nativeId;
    const confirmed = (await options.store.getApplyIntent(options.scope, `intent:${eventKey}`))
      ?.nativeResultConfirmation;
    if (confirmed?.kind !== 'candidate_event') {
      await options.store.recordPullApiEvidence(options.scope, eventKey, { operationId: event.operation.opId,
        nativeId, recovery: 'uncertain_create' }).catch((error) => logBackgroundFailure('pull.record-uncertain-create-evidence', error));
    }
    const resumed = await resumeSnapshotDeferredCreate(options, api, eventKey, event, mappingFor(effect.node, nativeId,
      parent.nativeId, parent.colpId, effect.kind === 'node_created' ? effect.nodeChildrenRevision : null, parent.rootNativeId));
    await options.store.commitPullEvent(options.scope, eventKey, { mappings: [resumed.mapping,
      await parentRevisionMapping(effect.parentRevision, event, nativeId)], observations: resumed.rangeExit ? [resumed.rangeExit.observation] : [],
      deleteNativeIds: existing && isRecoveryPlaceholder(existing.nativeId) ? [existing.nativeId] : [],
      apiResultEvidence: {
        operationId: event.operation.opId, recovery: 'uncertain_create' } });
  }

  async function recoverPostState(eventId: string, event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
    const effect = event.effect;
    if (await missingTerminalSelfDeletion(options, event)) {
      await commitMissingTerminalSelfDeletion(options, eventId, event, revision => parentRevisionMapping(revision, event)); return; }
    if (effect.kind === 'node_content_updated') { const mapping = await requireMapping(effect.node.id, 'target');
      if (isVirtualNativeId(mapping.nativeId)) { await callAndCommit(eventId, event); return; }
      const looked = await lookup(mapping.nativeId);
      if (looked.class === 'not_found') throw await targetMissingError(effect.node.id, mapping.nativeId);
      if (looked.class !== 'present') throw new Error(looked.message);
      const current = looked.nodes[0]; const content = nodeContent(effect.node);
      if (Object.keys(await pendingLocalContentForEvent(options.store, options.scope, mapping, event)).length) { await callAndCommit(eventId, event); return; }
      if (current && current.title === content.title
          && (content.url === undefined || current.url === content.url)) {
        await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId,
          recovery: 'post_state' });
        await options.store.commitPullEvent(options.scope, eventId, { mappings: [mappingFor(effect.node,
          mapping.nativeId, mapping.parentNativeId ?? null, effect.node.parentId,
          mapping.projection.childrenRevision ?? null, mapping.rootNativeId)],
          apiResultEvidence: { operationId: event.operation.opId,
            recovery: 'post_state' } }); return; }
    }
    if (effect.kind === 'node_moved') { const mapping = await requireMapping(effect.node.id, 'target');
      const storedAction = rangeActionOf((await options.store.getApplyIntent(options.scope, `intent:${eventId}`))?.anchors);
      if (storedAction === 'materialize_independent' || isVirtualNativeId(mapping.nativeId)
          || frozenRangeAction(storedAction)) {
        await callAndCommit(eventId, event); return; }
      const parent = await requireMapping(effect.placement.parentId, 'parent');
      const looked = await lookup(mapping.nativeId);
      if (looked.class === 'not_found') throw await targetMissingError(effect.node.id, mapping.nativeId);
      if (looked.class !== 'present') throw new Error(looked.message);
      const current = looked.nodes[0];
      const index = await nativeIndex(effect.placement.afterId, effect.placement.beforeId);
      if (current?.parentId === parent.nativeId && current.index === index) {
        await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId,
          recovery: 'post_state' });
        await options.store.commitPullEvent(options.scope, eventId, { mappings: [mappingFor(effect.node,
          mapping.nativeId, parent.nativeId, parent.colpId, mapping.projection.childrenRevision ?? null, parent.rootNativeId),
          ...(await Promise.all(effect.parentRevisions.map(revision => parentRevisionMapping(revision, event))))],
          apiResultEvidence: { operationId: event.operation.opId, recovery: 'post_state' } }); return; }
    }
    await callAndCommit(eventId, event);
  }

  async function enterRecoveryRequired(code: string) {
    await freezePullApply(options, code);
  }

  async function observe(event: NativeEvent) {
    let details = event.details;
    let nativeId = event.nativeId;
    if (event.kind === 'change') {
      const mapping = await options.store.getMappingByNativeId(options.scope, event.nativeId);
      if (mapping?.projection.content) details = { ...nativeContent(mapping.projection.content), ...event.details };
    }
    if (event.kind === 'create') {
      const { index: _index, ...rest } = details as JsonObject & { readonly index?: JsonValue };
      details = rest; nativeId = '';
    }
    const correlationId = digest({ kind: event.kind, nativeId, details });
    const evidence = { eventDigest: correlationId, ...(event.kind === 'create' ? { nativeId: event.nativeId } : {}) };
    if (await options.store.observeApplyIntentEvent(options.scope, correlationId, evidence)) return true;
    if (event.kind !== 'create' || !details || typeof details !== 'object' || Array.isArray(details)
        || !('node' in details)) return false;
    const fallback = digest({ kind: 'create', nativeId: '', details: { node: (details as { readonly node: unknown }).node } });
    return options.store.observeApplyIntentEvent(options.scope, fallback, { eventDigest: fallback, nativeId: event.nativeId });
  }
  return Object.freeze({ preflight, preflightMapping, resume, observe });
}
