import { SnapshotItemPreconditionError } from './snapshot-item-precondition.js';
import { readOpenSyncIssues, snapshotIssueProtectionIds } from './sync-issues.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullBookmarkApi } from './pull-applier.js';
import { isSpecialMountRole } from './pull-mount-apply.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { applySnapshotContent, planSnapshotContentUpdates, type RecoveryContentStore } from './recovery-content.js';
import { applySnapshotPlacement, planSnapshotPlacementUpdates } from './recovery-placement.js';
import {
  createIdentityNeedsOccupancy, projectionOccupancy, resolveCreateIdentity, virtualNativeId,
} from './projection-native-occupancy.js';
import {
  createProjectionSuppression,
  overlayNodesFromMappings,
  planRecoveryOverlay,
  type NativeFact,
  type ProjectionIntent,
  type ProjectionIntentRecord,
  type RecoveryOverlayNode,
} from './recovery-overlay.js';
import { executeNativeCreate } from './native-create-executor.js';
import { containAmbiguousProjection, containProjectionFailure } from './projection-containment.js';
import { recordedProjectionCreate } from './projection-create-receipt.js';
import { rejectedChromeBookmarkUrl } from './pull-projection.js';
import { scopeKey } from './sync-state/scope-key.js';
import { pendingLocalDeletionIds, retainedDeletionMappings } from './recovery-local-deletes.js';
import type { MappingInput, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

export type ProjectionApplyBarrier = 'after_chrome_create_before_mapping';
/**
 * `throw` fails the apply at the barrier; `hold` suspends it there.
 *
 * `throw` is the original behaviour and simulates a crash AFTER the browser
 * bookmark exists but BEFORE its mapping is durable. `hold` goes further: it
 * leaves that window OPEN, so a test can interrupt the worker while a multi-step
 * durable write is genuinely mid-flight rather than already unwound — which is
 * the only way to exercise the interruption MV3 actually produces.
 */
export type ProjectionApplyBarrierMode = 'throw' | 'hold';

let projectionApplyBarrier: ProjectionApplyBarrier | undefined;
let projectionApplyBarrierMode: ProjectionApplyBarrierMode = 'throw';
let projectionApplyBarrierHits = 0;
let projectionApplyBarrierWaiters: Array<() => void> = [];

export function configureProjectionApplyBarrier(barrier?: ProjectionApplyBarrier,
  mode: ProjectionApplyBarrierMode = 'throw'): void {
  projectionApplyBarrier = barrier;
  projectionApplyBarrierMode = mode;
  projectionApplyBarrierHits = 0;
  for (const release of projectionApplyBarrierWaiters) release();
  projectionApplyBarrierWaiters = [];
}

export function projectionApplyBarrierStatus():
{ readonly armed: boolean; readonly hits: number; readonly held: number; readonly mode: ProjectionApplyBarrierMode } {
  return { armed: projectionApplyBarrier !== undefined, hits: projectionApplyBarrierHits,
    held: projectionApplyBarrierWaiters.length, mode: projectionApplyBarrierMode };
}

/** Releases an apply held by the `hold` mode without failing it. */
export function releaseProjectionApplyBarrier(): number {
  const released = projectionApplyBarrierWaiters.length;
  for (const release of projectionApplyBarrierWaiters) release();
  projectionApplyBarrierWaiters = [];
  return released;
}

async function tripProjectionApplyBarrier(): Promise<void> {
  if (projectionApplyBarrier !== 'after_chrome_create_before_mapping') return;
  if (typeof __KNOWN_EXTENSION_EVIDENCE__ !== 'undefined' && __KNOWN_EXTENSION_EVIDENCE__ === false) return;
  projectionApplyBarrierHits += 1;
  if (projectionApplyBarrierMode === 'hold') {
    // Stay HERE: the bookmark exists and the mapping does not. The worker can now
    // be interrupted with that window open instead of after it has closed.
    await new Promise<void>((release) => { projectionApplyBarrierWaiters.push(release); });
    return;
  }
  projectionApplyBarrier = undefined;
  throw new SyncFailureError('projection_apply_barrier');
}

type RecoveryStore = RecoveryContentStore & Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'listMappings' | 'listQueue' | 'listQueueByTarget' | 'listBookmarkEventsByNative'
  | 'listProjectionIntents' | 'replaceProjectionIntents'
  | 'settleProjectionIntent' | 'exportScope' | 'putMapping' | 'getMappingByColpId' | 'deleteMapping'
  | 'getApplyIntent' | 'createApplyIntent' | 'findApplyIntent' | 'listApplyIntents'
  | 'persistApplyIntentFacts' | 'listLocalSyncExclusions' | 'getPullEvent'
  | 'recordLocalIssue' | 'listPullIssues' | 'listLocalIssues' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'
  | 'putLocalSyncExclusion' | 'markPullBrowserCallStarted' | 'recordPullApiEvidence' | 'getMappingByNativeId'
  | 'recordApplyFailure'>;

export async function recoverSnapshotProjection(input: {
  readonly scope: SyncScope;
  readonly store: RecoveryStore;
  readonly staged: readonly MappingInput[];
  readonly api: PullBookmarkApi;
  readonly allowTitleUrlIdentityGuess?: boolean; readonly recoveryOnly?: boolean;
}): Promise<readonly MappingInput[]> {
  const scopeRecord = await input.store.getScope(input.scope);
  const allLive = (await input.store.listMappings(input.scope)).map(({ scopeKey: _key, ...row }) => row);
  const deleted = await pendingLocalDeletionIds(input.store, input.scope, [...allLive, ...input.staged]);
  const live = allLive.filter(row => !deleted.has(row.colpId));
  const retainedDeletes = retainedDeletionMappings(allLive, input.staged, deleted);
  const selected = live.find((mapping) => scopeRecord?.selectedRoots.includes(mapping.colpId));
  if (!selected) throw new SyncFailureError('snapshot_root_mapping_missing');
  const existing = await input.store.listProjectionIntents(input.scope);
  const protectedIds = await protectedSnapshotIds(input.store, input.scope, live, input.staged);
  const held = existing.filter(item => item.state !== 'terminal' && protectedIds.has(item.colpId));
  const pending = existing.filter(item => item.state !== 'terminal' && !protectedIds.has(item.colpId));
  if (pending.length === 0 && input.recoveryOnly) return input.staged;
  if (pending.length === 0) {
    const outstanding = await listOutstanding(input.store, input.scope);
    const nativeFacts = await collectNativeFacts(input.api, selected.nativeId);
    const snapshot = overlayNodesFromRecovery(input.staged, await input.store.exportScope(input.scope))
      .filter(row => !deleted.has(row.colpId));
    const plan = planRecoveryOverlay({
      snapshot, mappings: live, outstanding, nativeFacts, selectedRootNativeId: selected.nativeId,
      allowTitleUrlIdentityGuess: input.allowTitleUrlIdentityGuess,
      issueProtectedIds: await protectedSnapshotIds(input.store, input.scope, live, input.staged),
    });
    await input.store.replaceProjectionIntents(input.scope, [...held, ...plan.intents.map((intent) => ({
      ...intent, generation: input.scope.generation, state: 'pending' as const,
    }))].map((intent, index) => ({ ...intent, order: index + 1 })));
    return executeProjectionIntents({
      ...input, selectedRootNativeId: selected.nativeId, seedMappings: [...plan.targetMappings, ...retainedDeletes],
    });
  }
  return executeProjectionIntents({
    ...input, selectedRootNativeId: selected.nativeId,
    seedMappings: [...input.staged.filter(row => !deleted.has(row.colpId)), ...retainedDeletes],
  });
}

export async function projectVirtualSnapshotChildren(input: {
  readonly scope: SyncScope;
  readonly store: RecoveryStore;
  readonly api: PullBookmarkApi;
  readonly bound: readonly MappingInput[];
  readonly snapshotCursor?: string; readonly recoveryOnly?: boolean;
}): Promise<readonly MappingInput[]> {
  const allLive = (await input.store.listMappings(input.scope)).map(({ scopeKey: _key, ...row }) => row);
  const deleted = await pendingLocalDeletionIds(input.store, input.scope, [...allLive, ...input.bound]);
  const protectedIds = await protectedSnapshotIds(input.store, input.scope, allLive, input.bound);
  const bound = new Map(input.bound.map(row => [row.colpId, row]));
  for (const row of allLive) if (protectedIds.has(row.colpId)) {
    const { scopeKey: _key, ...mapping } = row as MappingInput & { scopeKey?: string };
    bound.set(row.colpId, mapping);
  }
  const seed = inheritBoundNativeParents([...[...bound.values()].filter(row => !deleted.has(row.colpId)),
    ...retainedDeletionMappings(allLive, input.bound, deleted)]);
  const existing = await input.store.listProjectionIntents(input.scope);
  const held = existing.filter(item => item.state !== 'terminal' && protectedIds.has(item.colpId));
  const pending = existing.filter(item => item.state !== 'terminal' && !protectedIds.has(item.colpId));
  if (pending.length === 0 && input.recoveryOnly) return seed;
  if (pending.length === 0) {
    const live = await input.store.listMappings(input.scope);
    const intents = [...planVirtualChildCreates(seed),
      ...planSnapshotPlacementUpdates(seed, live), ...planSnapshotContentUpdates(seed, live)]
      .filter(intent => !protectedIds.has(intent.colpId))
      .map((intent, index) => ({ ...intent, order: index + 1 }));
    if (intents.length === 0) return seed;
    await input.store.replaceProjectionIntents(input.scope, [...held, ...intents.map((intent) => ({
      ...intent, generation: input.scope.generation, state: 'pending' as const,
    }))].map((intent, index) => ({ ...intent, order: index + 1 })));
  }
  const native = seed.find((mapping) => !virtualNativeId(mapping.nativeId))?.nativeId ?? seed[0]?.nativeId;
  if (!native) return seed;
  const projected = inheritBoundNativeParents(await executeProjectionIntents({
    scope: input.scope, store: input.store, api: input.api, selectedRootNativeId: native,
    seedMappings: seed, snapshotCursor: input.snapshotCursor, recoveryOnly: input.recoveryOnly,
  }));
  for (const mapping of input.recoveryOnly ? [] : projected) {
    if (mapping.colpId.startsWith('pending-') || mapping.nativeId.startsWith('pending-')) continue;
    const { scopeKey: _scopeKey, ...row } = mapping as MappingInput & { readonly scopeKey?: string };
    await input.store.putMapping(input.scope, row);
  }
  return projected;
}

export async function executeProjectionIntents(input: {
  readonly scope: SyncScope;
  readonly store: RecoveryStore;
  readonly api: PullBookmarkApi;
  readonly selectedRootNativeId: string;
  readonly seedMappings: readonly MappingInput[];
  readonly persistMappings?: boolean;
  readonly snapshotCursor?: string; readonly recoveryOnly?: boolean;
}): Promise<readonly MappingInput[]> {
  const mappings = new Map(input.seedMappings.map((mapping) => [mapping.colpId, mapping]));
  // Keep the verified Snapshot target immutable while a placement intent holds
  // the native content baseline until the following content intent runs.
  const snapshotMappings = new Map(input.seedMappings.map((mapping) => [mapping.colpId, mapping]));
  const persist = input.persistMappings !== false;
  const intents = [...await input.store.listProjectionIntents(input.scope)]
    .sort((left, right) => left.order - right.order);
  // B-16: what the open intents claim, read once; re-listing every intent for each create is O(N^2) on a large Snapshot.
  const claims = new Map(intents.flatMap((row) => row.state !== 'terminal' && row.observedNativeId && !virtualNativeId(row.observedNativeId)
    ? [[row.observedNativeId, row.colpId] as const] : []));
  const liveMappings = (await input.store.listMappings(input.scope)).map(({ scopeKey: _key, ...row }) => row);
  const deleted = await pendingLocalDeletionIds(input.store, input.scope, [...liveMappings, ...input.seedMappings]);
  for (const intent of intents) {
    if (input.recoveryOnly && !['executing', 'recovery'].includes(intent.state)) continue;
    const protectedIds = await protectedSnapshotIds(input.store, input.scope, liveMappings, input.seedMappings);
    if (intent.state !== 'terminal' && protectedIds.has(intent.colpId)) {
      // Never discard a call that might have started. Resolve it through its existing evidence path.
      if (intent.state === 'pending' || intent.kind === 'delete') {
        const prior = liveMappings.find(row => row.colpId === intent.colpId);
        if (prior) mappings.set(prior.colpId, prior);
        continue;
      }
    }
    if (deleted.has(intent.colpId)) {
      // Retain the old identity for the removal draft's later queue commit.
      // A pre-pause projection intent must not recreate or update this native.
      const prior = liveMappings.find(row => row.colpId === intent.colpId);
      if (prior && mappings.has(intent.colpId)) {
        const { scopeKey: _key, ...mapping } = prior as MappingInput & { scopeKey?: string };
        mappings.set(intent.colpId, mapping);
      }
      else {
        const staged = mappings.get(intent.colpId);
        if (staged) mappings.set(intent.colpId, { ...staged, nativeId: `sidecar:local-delete:${intent.colpId}` });
      }
      if (intent.state !== 'terminal') await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'terminal' });
      continue;
    }
    if (intent.state === 'terminal') {
      // Terminal observations prove their old side effect, not the current
      // native after a later Pull restore/rebind. Mapping commit precedes
      // terminal, so the durable mapping is the authority for replay.
      const live = await input.store.getMappingByColpId(input.scope, intent.colpId);
      if (live && !virtualNativeId(live.nativeId)) {
        applyObserved(mappings, { ...intent, observedNativeId: live.nativeId, parentNativeId: live.parentNativeId });
      }
      continue;
    }
    if (intent.generation !== input.scope.generation) throw new SyncFailureError('projection_generation_fenced');
    await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'executing' });
    let observed: string | undefined | 'ambiguous';
    let activeIntent = intent;
    try {
      activeIntent = prepareCreateIntent(intent, mappings);
      activeIntent = prepareMoveIntent(activeIntent, mappings);
      if (activeIntent !== intent) {
        await input.store.settleProjectionIntent(input.scope, intent.intentId, {
          state: 'executing', suppression: activeIntent.suppression,
          parentNativeId: activeIntent.parentNativeId,
        });
      }
      // Read the claims of the whole library only for a create that meets an equal bookmark or a recorded answer.
      let claimed: Promise<ReadonlyMap<string, string>> | undefined;
      const occupancy = () => claimed ??= projectionOccupancy(input.store, input.scope, mappings.values());
      observed = await perform(input.api, activeIntent, mappings, snapshotMappings, occupancy, { ...input, claims });
    } catch (error) {
      if (error instanceof SnapshotItemPreconditionError && error.subject?.nativeId) {
        await input.store.recordLocalIssue(input.scope, { code: error.code, nativeId: error.subject.nativeId, now: Date.now() });
        const prior = liveMappings.find(row => row.colpId === intent.colpId);
        if (prior) mappings.set(intent.colpId, prior);
        await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'pending' });
        continue;
      }
      // B-04 / W2C-11: a refusal about this one node is counted, an unresolved parent waits, a vanished target is
      // named; none of them stops the other nodes. Anything else keeps its durable retryable state below.
      if (await containProjectionFailure({ store: input.store, scope: input.scope, intent,
        nativeId: issueNativeId(intent, snapshotMappings, mappings), now: Date.now() }, error)) {
        const prior = liveMappings.find(row => row.colpId === intent.colpId);
        if (prior) mappings.set(intent.colpId, prior);
        continue;
      }
      // Never swallow a native update/move/delete failure. Persist a durable
      // retryable state so a subsequent worker can resume from this intent
      // without guessing whether Chrome applied the side effect.
      await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'recovery' });
      throw error;
    }
    if (observed === 'ambiguous') {
      await containAmbiguousProjection({ store: input.store, scope: input.scope, intent,
        nativeId: issueNativeId(intent, snapshotMappings, mappings), now: Date.now() });
      continue;
    }
    try {
      if (intent.kind === 'delete' && intent.nativeId) {
        await input.store.deleteMapping(input.scope, intent.nativeId);
        if (mappings.get(intent.colpId)?.nativeId === intent.nativeId) mappings.delete(intent.colpId);
        await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'terminal' });
      } else if (observed) {
        await commitObservedNative({
          store: input.store, scope: input.scope, intent: activeIntent,
          observed, mappings,
        });
        claims.delete(observed);
      } else {
        await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'terminal' });
      }
    } catch (error) {
      await input.store.settleProjectionIntent(input.scope, intent.intentId, { state: 'recovery' });
      throw error;
    }
  }
  if (persist && !input.recoveryOnly) {
    for (const mapping of mappings.values()) await persistProjectionMapping(input.store, input.scope, mapping);
  }
  return [...mappings.values()];
}

/** The browser id an issue about this intent is shown for: the node's own, or its `recovery:` placeholder. */
function issueNativeId(intent: ProjectionIntentRecord, snapshotMappings: ReadonlyMap<string, MappingInput>,
  mappings: ReadonlyMap<string, MappingInput>): string {
  return (snapshotMappings.get(intent.colpId) ?? mappings.get(intent.colpId))?.nativeId
    ?? intent.nativeId ?? `recovery:${intent.colpId}`;
}

function prepareCreateIntent(
  intent: ProjectionIntentRecord,
  mappings: ReadonlyMap<string, MappingInput>,
): ProjectionIntentRecord {
  if (intent.kind !== 'create' || intent.parentNativeId || !intent.parentColpId) return intent;
  const parentNativeId = mappings.get(intent.parentColpId)?.nativeId;
  if (!parentNativeId || virtualNativeId(parentNativeId)) {
    throw new SyncFailureError('snapshot_parent_mapping_missing');
  }
  return {
    ...intent,
    parentNativeId,
    suppression: createProjectionSuppression(parentNativeId, intent.title ?? '', intent.url),
  };
}

function prepareMoveIntent(
  intent: ProjectionIntentRecord,
  mappings: ReadonlyMap<string, MappingInput>,
): ProjectionIntentRecord {
  if (intent.kind !== 'move' || intent.parentNativeId || !intent.parentColpId) return intent;
  const parentNativeId = mappings.get(intent.parentColpId)?.nativeId;
  if (!parentNativeId || virtualNativeId(parentNativeId)) throw new SyncFailureError('snapshot_parent_mapping_missing');
  return { ...intent, parentNativeId };
}

export async function collectNativeFacts(api: PullBookmarkApi, rootNativeId: string): Promise<NativeFact[]> {
  const facts: NativeFact[] = [];
  const visit = async (nativeId: string, parentNativeId: string | undefined) => {
    const looked = await lookupBookmark(id => api.get(id), nativeId);
    if (looked.class === 'not_found') return;
    if (looked.class !== 'present') throw new Error(looked.message);
    const node = looked.nodes[0];
    if (!node) return;
    const siblings = parentNativeId ? await api.getChildren(parentNativeId) : [];
    const index = siblings.findIndex((item) => item.id === nativeId);
    facts.push({
      nativeId, title: node.title ?? '', ...(node.url ? { url: node.url } : {}),
      ...(parentNativeId ? { parentNativeId } : {}), index: Math.max(0, index),
      folder: node.url === undefined,
    });
    if (node.url !== undefined) return;
    const children = await api.getChildren(nativeId);
    for (const child of children) await visit(child.id, nativeId);
  };
  await visit(rootNativeId, undefined);
  return facts;
}

async function listOutstanding(
  store: RecoveryStore, scope: SyncScope,
): Promise<QueueOperation[]> {
  // Held rows are still this browser's intent; recovery must not overwrite their targets.
  const live: Array<'pending' | 'claimed' | 'deferred' | 'gap' | 'blocked' | 'unknown' | 'set_aside'> = [
    'pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside',
  ];
  const heads = await Promise.all(live.map(async (status) => {
    const rows: QueueOperation[] = [];
    let after = 0;
    for (;;) {
      const page = await store.listQueue(scope, status, after, 1_000);
      rows.push(...page);
      if (page.length < 1_000) return rows;
      after = page[page.length - 1]!.sequence;
    }
  }));
  return heads.flat().sort((left, right) => left.sequence - right.sequence);
}

function overlayNodesFromRecovery(
  staged: readonly MappingInput[], exported: { readonly recoveryNodes?: readonly {
    readonly colpId: string; readonly parentId: string | null; readonly position: string;
    readonly kind?: string; readonly mapping?: MappingInput;
  }[] },
): RecoveryOverlayNode[] {
  const byColp = new Map((exported.recoveryNodes ?? []).map((node) => [node.colpId, node]));
  if (byColp.size === 0) return overlayNodesFromMappings(staged);
  return staged.map((mapping) => {
    const node = byColp.get(mapping.colpId);
    const content = mapping.projection.content ?? {};
    return {
      colpId: mapping.colpId, parentColpId: node?.parentId ?? mapping.parentColpId ?? null,
      position: node?.position ?? mapping.colpId,
      kind: mapping.nodeKind ?? 'folder',
      title: typeof content.title === 'string' ? content.title : '',
      ...(typeof content.url === 'string' ? { url: content.url } : {}),
      mapping,
    };
  });
}

function applyObserved(mappings: Map<string, MappingInput>, intent: Pick<ProjectionIntentRecord, 'colpId' | 'observedNativeId' | 'parentNativeId'>) {
  const current = mappings.get(intent.colpId);
  if (!current || !intent.observedNativeId) return;
  mappings.set(intent.colpId, {
    ...current, nativeId: intent.observedNativeId,
    ...(intent.parentNativeId ? { parentNativeId: intent.parentNativeId } : {}),
  });
}

async function commitObservedNative(input: {
  readonly store: RecoveryStore; readonly scope: SyncScope; readonly intent: ProjectionIntentRecord;
  readonly observed: string; readonly mappings: Map<string, MappingInput>;
}): Promise<void> {
  await input.store.settleProjectionIntent(input.scope, input.intent.intentId, {
    state: 'executing', observedNativeId: input.observed,
  });
  applyObserved(input.mappings, { ...input.intent, observedNativeId: input.observed });
  await tripProjectionApplyBarrier();
  await persistProjectionMapping(input.store, input.scope, input.mappings.get(input.intent.colpId));
  await input.store.settleProjectionIntent(input.scope, input.intent.intentId, {
    state: 'terminal', observedNativeId: input.observed,
  });
}

async function persistProjectionMapping(
  store: RecoveryStore, scope: SyncScope, mapping: MappingInput | undefined,
): Promise<void> {
  if (!mapping || mapping.colpId.startsWith('pending-') || mapping.nativeId.startsWith('pending-')) return;
  const { scopeKey: _scopeKey, ...row } = mapping as MappingInput & { readonly scopeKey?: string };
  await store.putMapping(scope, row);
}

async function perform(
  api: PullBookmarkApi, intent: ProjectionIntentRecord, mappings: Map<string, MappingInput>,
  snapshotMappings: ReadonlyMap<string, MappingInput>,
  occupancy: () => Promise<ReadonlyMap<string, string>>,
  ctx: { readonly scope: SyncScope; readonly store: RecoveryStore; readonly snapshotCursor?: string;
    readonly claims: ReadonlyMap<string, string> },
): Promise<string | undefined | 'ambiguous'> {
  if (intent.kind === 'create') {
    const parentNativeId = intent.parentNativeId
      ?? (intent.parentColpId ? mappings.get(intent.parentColpId)?.nativeId : undefined);
    if (!parentNativeId || virtualNativeId(parentNativeId)) throw new SyncFailureError('snapshot_parent_mapping_missing');
    const children = await api.getChildren(parentNativeId);
    // B-04: the receipt of a create that already happened answers before the equal-content check can call it unknown.
    const recorded = await recordedProjectionCreate(ctx.store, ctx.scope, intent.intentId, children, occupancy, intent.colpId);
    if (recorded) return recorded;
    const claimed = createIdentityNeedsOccupancy(intent, children) ? await occupancy() : new Map<string, string>();
    const resolution = resolveCreateIdentity({ intent, children, occupancy: claimed });
    if (resolution.action === 'ambiguous') return 'ambiguous';
    if (resolution.action === 'reuse') {
      const owner = claimed.get(resolution.nativeId);
      if (owner !== undefined && owner !== intent.colpId) return 'ambiguous';
      return resolution.nativeId;
    }
    // Chrome was not called, so this must not park the snapshot in recovery.
    const rejectedUrl = intent.folder ? null : rejectedChromeBookmarkUrl(intent.url);
    if (rejectedUrl) {
      const nativeId = (snapshotMappings.get(intent.colpId) ?? mappings.get(intent.colpId))?.nativeId
        ?? intent.nativeId ?? `recovery:${intent.colpId}`;
      await ctx.store.recordLocalIssue(ctx.scope, { code: rejectedUrl, nativeId,
        ...(intent.title ? { title: intent.title } : {}), now: Date.now() });
      return undefined;
    }
    const index = clampRecoveryCreateIndex(intent.index, children.length);
    const outcome = await executeNativeCreate({
      scope: ctx.scope, store: ctx.store, api,
      intentId: `projection:${intent.intentId}`,
      owner: {
        scopeKey: scopeKey(ctx.scope), generation: ctx.scope.generation, commandId: 'projection',
        eventId: intent.intentId, colpId: intent.colpId, substep: 'projection',
      },
      parentNativeId, expected: { title: intent.title ?? '', ...(intent.url ? { url: intent.url } : {}) },
      liveWorkKind: 'create', projectionClaims: ctx.claims,
      create: async () => api.create({
        parentId: parentNativeId, title: intent.title ?? '',
        ...(intent.url ? { url: intent.url } : {}),
        ...(index === undefined ? {} : { index }),
      }),
    });
    // A refused call (a lost permission) is not an unknown result: it stops the projection, it does not name this node.
    if (outcome.result === 'failed') throw new Error(outcome.code);
    if (outcome.result !== 'applied_with_evidence') return 'ambiguous';
    return outcome.nativeId;
  }
  if (intent.kind === 'update' && intent.nativeId) {
    const incoming = snapshotMappings.get(intent.colpId) ?? mappings.get(intent.colpId);
    if (!incoming) throw new SyncFailureError('snapshot_content_baseline_missing');
    mappings.set(intent.colpId, await applySnapshotContent({ store: ctx.store, scope: ctx.scope, api,
      incoming, intent, cursor: ctx.snapshotCursor }));
    return intent.nativeId;
  }
  if (intent.kind === 'move' && intent.nativeId) {
    const incoming = snapshotMappings.get(intent.colpId) ?? mappings.get(intent.colpId);
    if (!incoming) throw new SyncFailureError('snapshot_placement_baseline_missing');
    mappings.set(intent.colpId, await applySnapshotPlacement({
      store: ctx.store, scope: ctx.scope, api, incoming, intent,
    }));
    return intent.nativeId;
  }
  if (intent.kind === 'delete' && intent.nativeId) {
    // A missing delete target is an idempotent success. Other failures must
    // remain visible to the executor and leave the intent in recovery state.
    const existing = await lookupBookmark(id => api.get(id), intent.nativeId);
    if (existing.class !== 'present' && existing.class !== 'not_found') throw new Error(existing.message);
    if (existing.class === 'present') {
      // The plan already orders explicit member deletes child-first. Recursive
      // removal would also erase local-only or newly arrived descendants that
      // the plan never authorized. Chrome's atomic non-empty check keeps those
      // copies intact and leaves the intent recoverable until they move away.
      await api.remove(intent.nativeId);
    }
    return intent.nativeId;
  }
  return intent.nativeId;
}

export function clampRecoveryCreateIndex(index: number | undefined, childCount: number): number | undefined {
  return index === undefined ? undefined : Math.min(index, childCount);
}

function planVirtualChildCreates(seed: readonly MappingInput[]): ProjectionIntent[] {
  const byColp = new Map(seed.map((mapping) => [mapping.colpId, mapping]));
  const creatable = new Set<string>();
  const intents: ProjectionIntent[] = [];
  let order = 0;
  for (const mapping of seed) {
    if (mapping.quarantine || !projectableVirtualNative(mapping.nativeId) || skipVirtualChromeCreate(mapping)) continue;
    const parent = mapping.parentColpId ? byColp.get(mapping.parentColpId) : undefined;
    if (!parent || (virtualNativeId(parent.nativeId) && !creatable.has(parent.colpId))) continue;
    creatable.add(mapping.colpId);
    const content = mapping.projection.content ?? {};
    const title = typeof content.title === 'string' ? content.title : '';
    const url = typeof content.url === 'string' ? content.url : undefined;
    const parentNativeId = virtualNativeId(parent.nativeId) ? undefined : parent.nativeId;
    intents.push({
      intentId: `create:${mapping.colpId}`, kind: 'create', colpId: mapping.colpId, order: ++order,
      suppression: parentNativeId
        ? createProjectionSuppression(parentNativeId, title, url) : `recovery:create:${mapping.colpId}`,
      parentColpId: mapping.parentColpId, ...(parentNativeId ? { parentNativeId } : {}),
      title, ...(url ? { url } : {}), folder: mapping.nodeKind === 'folder',
    });
  }
  return intents;
}

export function hasProjectableVirtualChildren(mappings: readonly MappingInput[], protectedIds: ReadonlySet<string> = new Set()): boolean {
  return planVirtualChildCreates(inheritBoundNativeParents(mappings)).some(intent => !protectedIds.has(intent.colpId));
}

function skipVirtualChromeCreate(mapping: MappingInput): boolean {
  if (mapping.nodeKind === 'separator') return true;
  const role = mapping.rootRole
    ?? (typeof mapping.projection.content?.folderRole === 'string' ? mapping.projection.content.folderRole : undefined);
  return isSpecialMountRole(role) || role === 'custom' || role === 'root' || role === 'managed-bookmarks';
}

/** Unmounted/sidecar identities are intentional remote-only state, not an interrupted create. */
export const PROJECTABLE_NATIVE_PREFIX = 'recovery:';

function projectableVirtualNative(nativeId: string): boolean {
  return nativeId.startsWith(PROJECTABLE_NATIVE_PREFIX);
}

function inheritBoundNativeParents(mappings: readonly MappingInput[]): MappingInput[] {
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping]));
  const pending = [...mappings];
  const placed = new Set<string>();
  const ordered: MappingInput[] = [];
  while (pending.length) {
    const index = pending.findIndex((mapping) => !mapping.parentColpId || placed.has(mapping.parentColpId));
    if (index < 0) break;
    const [mapping] = pending.splice(index, 1) as [MappingInput];
    const parent = mapping.parentColpId ? byColp.get(mapping.parentColpId) : undefined;
    const next = parent && !virtualNativeId(parent.nativeId) ? {
      ...mapping, rootNativeId: parent.rootNativeId, parentNativeId: parent.nativeId,
      ...(parent.mountId && !mapping.mountId ? { mountId: parent.mountId } : {}),
    } : mapping;
    byColp.set(mapping.colpId, next);
    ordered.push(next);
    placed.add(mapping.colpId);
  }
  for (const mapping of pending) ordered.push(byColp.get(mapping.colpId) ?? mapping);
  return ordered;
}

async function protectedSnapshotIds(store: RecoveryStore, scope: SyncScope, mappings: readonly MappingInput[], staged: readonly MappingInput[] = []) {
  const roots = (await readOpenSyncIssues(store, scope)).roots;
  // No open issue protects nothing; the ancestry of every mapping is not built for it (once per intent otherwise).
  return roots.size === 0 ? new Set<string>() : snapshotIssueProtectionIds(mappings, staged, roots);
}
