import { assertRejoinDeleteUpload } from './scope-rejoin-upload.js';
import { assertBootstrapUploadAllowed } from './bootstrap/upload-boundary.js';
import { bootstrapOpId, mountResolveOpIdMatches } from './bootstrap/run-identity.js';
import { isAdvancedSnapshotFactDefinition, parseAdvancedPlanMetadata, parseAdvancedStepDefinition } from './bootstrap/advanced-record-validation.js';
import { advancedRemoteOperationFields } from './bootstrap/advanced-remote-executor.js';
import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { digestJson, plannedCreateNativeId } from './bookmark-event-codec.js';
import { resolveIngressBoundary } from './bookmark-event-ingress.js';
import { localRemovalCoversNative } from './local-create-successor.js';
import { boundNativeId, isNonChromeNativeId } from './pull-mount-apply.js';
import type { BookmarkEventRecord, JsonObject, MountBindingRecord, QueueOperation, ScopeRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
export class QueuedUploadExcludedError extends Error {
  readonly code = 'queued_upload_excluded';
  constructor(readonly reason: 'private_local' | 'unselected_range') { super('queued_upload_excluded'); }
}

/** Every native producer must obey the live boundary, including already durable drafts. */
export async function assertQueuedUploadAllowed(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly parentOf: (nativeId: string) => Promise<string | undefined>;
  /** Only the batch proof supplies this, and rechecks it before returning. */
  readonly subscriptionExclusions?: ReadonlySet<string>;
}): Promise<void> {
  const { store, scope, queue } = input;
  const payload = object(queue.payload.payload);
  const advancedOperation = queue.opId.startsWith('ab.');
  // These are separately confirmed cloud commands, not native-content uploads.
  if (!advancedOperation && ((['delete_node', 'delete_subtree'].includes(String(queue.payload.type)) && payload?.reason === 'scope_remote_delete')
      || (queue.payload.type === 'restore_node' && payload?.reason === 'remote_delete_restore'))) return;
  if (!advancedOperation && ['delete_node', 'delete_subtree'].includes(String(queue.payload.type)) && payload?.reason === 'rejoin_local_delete') {
    await assertRejoinDeleteUpload(input); return;
  }
  await assertBootstrapUploadAllowed(input);
  const recorded = await store.getScope(scope);
  if (recorded?.rootStatus !== 'ready' && recorded?.rootStatus !== 'nested_normalized') throw new Error('upload_boundary_unavailable');
  for (const id of recorded.privateRoots ?? []) {
    if (!await store.getMappingByColpId(scope, id)) throw new Error('upload_boundary_unavailable');
  }
  const boundary = await resolveIngressBoundary(store, scope, input.subscriptionExclusions);
  const mounts = await store.listMountBindings(scope);
  const sources = new Set<string>();
  const events: BookmarkEventRecord[] = [];
  const original = await store.getBookmarkEvent(scope, queue.opId);
  if (original) events.push(original);
  for (let after = 0;;) {
    const page = await store.listBookmarkEventsByOperation(scope, queue.opId, after, 1_000);
    events.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)!.ordinal;
  }
  for (const event of events) sources.add(event.nativeId);
  const planned = plannedCreateNativeId(queue.opId);
  if (planned) sources.add(planned);
  let bootstrapSourceKnown = Boolean(planned) || events.length > 0;
  for (const id of [`pending-${queue.opId}`, queue.payload.targetId, payload?.parentId, payload?.newParentId]) {
    if (typeof id !== 'string') continue;
    const mapped = await store.getMappingByColpId(scope, id);
    if (mapped) {
      const nativeId = boundNativeId(mapped, mounts);
      if (!isNonChromeNativeId(nativeId)) {
        sources.add(nativeId);
        if (id === `pending-${queue.opId}` || id === queue.payload.targetId) bootstrapSourceKnown = true;
      }
    }
  }
  const node = object(payload?.node);
  const role = node?.folderRole;
  const bootstrapCreate = queue.opId.startsWith('b3.') && queue.payload.type === 'create_node';
  if (bootstrapCreate) {
    // A selected nested mount has no folderRole. Its durable run and source
    // key still identify the exact native folder, including hashed operation ids.
    const runs = await store.listBootstrapRuns(scope);
    for (const mount of mounts) {
      const key = mount.rootRole ?? mount.customSourceKey;
      if (key && runs.some(run => bootstrapOpId(run.confirmationId, 'mount', key) === queue.opId)) {
        sources.add(mount.nativeRootId);
        bootstrapSourceKnown = true;
      }
    }
    if (!bootstrapSourceKnown) throw new Error('upload_boundary_unavailable');
  } else if (queue.payload.type === 'create_node' && typeof role === 'string') {
    for (const mount of mounts) if (mount.rootRole === role
        || role === 'custom' && mount.customSourceKey && mountResolveOpIdMatches(queue.opId, mount.customSourceKey)) sources.add(mount.nativeRootId);
  }
  // Advanced uploads and confirmed cloud-only deletions have different source
  // evidence. Both remain bound to the exact durable executing step and live
  // authority; an operation-id prefix alone grants no new range.
  const advanced = advancedOperation
    ? await advancedUploadAuthority({ store, scope, queue, recorded, mounts }) : undefined;
  if (advanced) for (const id of advanced.sources) sources.add(id);
  const selectedNative = new Set([...boundary.selectedNative, ...(advanced?.selected ?? [])]);
  if (sources.size === 0) throw new Error('upload_boundary_unavailable');
  for (const nativeId of sources) {
    let id: string | undefined = nativeId, inRange = false;
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id) || seen.size >= 256) throw new Error('upload_boundary_unavailable');
      seen.add(id);
      if (boundary.privateNative.has(id) || await store.getLocalSyncExclusion(scope, id)) throw new QueuedUploadExcludedError('private_local');
      if (selectedNative.has(id)) inRange = true;
      const current: string = id;
      try { id = await input.parentOf(current); }
      catch (error) {
        if (classifyBookmarkApiFailure(error) !== 'not_found') throw error;
        let removal = events.find(event => event.kind === 'remove' && (event.nativeId === current
          || Array.isArray(event.details.deleteNativeIds) && event.details.deleteNativeIds.includes(current)));
        if (!removal) {
          const mapping = await store.getMappingByNativeId(scope, current);
          for (let after = 0;;) {
            const page = await store.listBookmarkEventsByStatus(scope, 'pending', after, 1_000);
            removal = page.find(event => localRemovalCoversNative(event, current,
              mapping?.colpId ?? `pending-${queue.opId}`, queue.opId));
            if (removal || page.length < 1_000) break;
            after = page.at(-1)!.ordinal;
          }
        }
        // A missing native is usable only with a proven captured removal.
        // Bootstrap's stronger pending-successor check already ran above.
        if (!removal && !(planned === current && queue.opId.startsWith('b3.'))) throw error;
        id = (await store.listDeletionJournal(scope, current)).sort((a, b) => b.ordinal - a.ordinal)[0]?.parentNativeId;
        if (!id) throw error;
      }
    }
    // The confirmed bootstrap may need only the folder containers above a
    // directly selected subfolder. The source still passes every private and
    // exclusion check above; this never grants its unselected siblings upload.
    if (!inRange && (bootstrapCreate || advanced?.structuralCreate) && node?.kind === 'folder') {
      inRange = await requiredContainer(nativeId, selectedNative, input.parentOf,
        async id => boundary.privateNative.has(id) || !!await store.getLocalSyncExclusion(scope, id));
    }
    if (!inRange) throw new QueuedUploadExcludedError('unselected_range');
  }
}

async function advancedUploadAuthority(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly recorded: ScopeRecord; readonly mounts: readonly MountBindingRecord[];
}): Promise<{ sources: readonly string[]; selected: readonly string[]; structuralCreate: boolean }> {
  const { store, scope, queue, recorded, mounts } = input;
  const unavailable = () => { throw new Error('upload_boundary_unavailable'); };
  const persisted = await store.getQueueByOpId(scope, queue.opId);
  if (!persisted || persisted.sequence !== queue.sequence || persisted.digest !== queue.digest
      || queue.payload.opId !== queue.opId || queue.payload.sequence !== queue.sequence
      || digestJson(queue.payload) !== queue.digest || digestJson(persisted.payload) !== queue.digest) return unavailable();
  for (const plan of await store.listAdvancedPlans(scope)) {
    const loaded = await store.readAdvancedPlan(scope, plan.planId);
    const row = loaded?.steps.find(step => typeof step.definition.stepId === 'string'
      && `ab.${digestJson({ planId: plan.planId, stepId: step.definition.stepId }).slice(7)}` === queue.opId);
    if (!loaded || !row) continue;
    if (loaded.plan.state !== 'active' || row.state !== 'executing'
        || recorded.lifecycle !== 'active' || recorded.firstRun !== 'running') throw new QueuedUploadExcludedError('unselected_range');
    if (loaded.steps.slice(0, row.order).some(step => step.state !== 'terminal')) return unavailable();
    const metadata = parseAdvancedPlanMetadata(loaded.plan.metadata);
    const step = parseAdvancedStepDefinition(row.definition);
    if (isAdvancedSnapshotFactDefinition(step) || step.side !== 'remote'
        || metadata.mode === 'download' || queue.payload.type !== step.operation) return unavailable();
    const run = (await store.listBootstrapRuns(scope)).find(run => run.runId === plan.planId);
    if (!run || run.phase !== 'syncing' || run.confirmationId !== metadata.confirmationId
        || run.reportDigest !== loaded.plan.digest || run.treeDigest !== metadata.treeDigest) return unavailable();
    if (metadata.boundaryVersion !== undefined && ((recorded.boundaryVersion ?? '0') !== metadata.boundaryVersion
        || run.confirmationVersion !== metadata.boundaryVersion)) throw new QueuedUploadExcludedError('unselected_range');
    const completed = loaded.steps.slice(0, row.order);
    const inner = object(queue.payload.payload);
    let expected = advancedRemoteOperationFields(step, completed);
    if (step.action === 'move') {
      // These original fences cannot authorize another target or destination.
      // A fresh snapshot may have advanced after an unknown response, so keep
      // the immutable queue's valid fences for the server's compare-and-swap.
      if (typeof inner?.baseSourceParentRevision !== 'string' || !inner.baseSourceParentRevision
          || typeof inner.baseTargetParentRevision !== 'string' || !inner.baseTargetParentRevision) return unavailable();
      expected = { ...expected, payload: { ...expected.payload as JsonObject, baseSourceParentRevision: inner.baseSourceParentRevision,
        baseTargetParentRevision: inner.baseTargetParentRevision } };
    }
    const actual = { type: queue.payload.type, payload: inner ?? {},
      ...(queue.payload.baseRevision === undefined ? {} : { baseRevision: queue.payload.baseRevision }),
      ...(queue.payload.targetId === undefined ? {} : { targetId: queue.payload.targetId }) };
    if (digestJson(actual) !== digestJson(expected)) return unavailable();

    let mountNative: string;
    let sourceNative: string;
    if (step.action === 'delete') {
      // A cloud-only command carries no native content. Its frozen snapshot
      // ancestry must lead to one of this confirmation's original mounts.
      const definitions = loaded.steps.map(record => parseAdvancedStepDefinition(record.definition));
      const facts = new Map(definitions.filter(isAdvancedSnapshotFactDefinition).map(definition => [definition.fact.nodeId, definition.fact]));
      const target = facts.get(step.target.nodeId);
      if (!target || target.managed || target.privateLocal || target.revision !== step.before.revision
          || target.parentId !== step.before.parentId || target.kind !== step.before.kind) return unavailable();
      const mapped = await store.getMappingByColpId(scope, step.target.nodeId);
      if (mapped && !isNonChromeNativeId(boundNativeId(mapped, mounts))) return unavailable();
      let id = target.parentId;
      const seen = new Set<string>();
      let confirmedMount: typeof metadata.mounts[number] | undefined;
      while (id && !seen.has(id)) {
        seen.add(id); confirmedMount = metadata.mounts.find(mount => mount.remoteMountNodeId === id);
        if (confirmedMount) break;
        const ancestor = facts.get(id);
        if (!ancestor || ancestor.managed || ancestor.privateLocal) return unavailable();
        id = ancestor.parentId;
      }
      if (!confirmedMount) return unavailable();
      mountNative = sourceNative = confirmedMount.nativeRootId;
    } else {
      sourceNative = step.action === 'create' ? step.source.nativeId : step.target.nativeId;
      mountNative = step.action === 'create' ? step.source.fact.mountNativeRootId
        : (await store.getMappingByNativeId(scope, sourceNative))?.rootNativeId ?? '';
    }
    const confirmedMount = metadata.mounts.find(mount => mount.nativeRootId === mountNative);
    const liveMount = mounts.find(mount => mount.nativeRootId === mountNative);
    if (!confirmedMount || !liveMount || liveMount.status !== 'active'
        || liveMount.pendingRemoteDelete || metadata.boundaryVersion !== undefined
          && liveMount.boundaryVersion !== metadata.boundaryVersion) throw new QueuedUploadExcludedError('unselected_range');
    if (confirmedMount.remoteMountNodeId !== null && liveMount.remoteMountNodeId !== confirmedMount.remoteMountNodeId) return unavailable();
    if (confirmedMount.remoteMountNodeId === null && liveMount.remoteMountNodeId !== null) {
      const created = completed.find(prior => prior.definition.side === 'remote' && prior.definition.action === 'create'
        && object(prior.definition.source)?.nativeId === mountNative);
      if (created?.evidence?.targetId !== liveMount.remoteMountNodeId) return unavailable();
    }
    const creatingMount = step.action === 'create' && step.source.nativeId === mountNative
      && step.source.fact.kind === 'folder' && confirmedMount.remoteMountNodeId === null && liveMount.remoteMountNodeId === null;
    if (liveMount.remoteMountNodeId === null && !creatingMount) return unavailable();
    return { sources: [sourceNative], selected: creatingMount ? [mountNative] : [],
      structuralCreate: step.action === 'create' && step.source.fact.kind === 'folder' };
  }
  return unavailable();
}

async function requiredContainer(nativeId: string, selected: ReadonlySet<string>,
  parentOf: (id: string) => Promise<string | undefined>, excluded: (id: string) => Promise<boolean>): Promise<boolean> {
  for (const selectedId of selected) {
    let current: string | undefined = selectedId;
    const seen = new Set<string>();
    while (current) {
      if (await excluded(current)) break;
      if (current === nativeId) return true;
      if (seen.has(current) || seen.size >= 256) throw new Error('upload_boundary_unavailable');
      seen.add(current); current = await parentOf(current);
    }
  }
  return false;
}

export function isUploadExcluded(error: unknown): boolean {
  return error instanceof Error && ['bootstrap_upload_excluded', 'queued_upload_excluded', 'subscription_upload_excluded'].includes(error.message);
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
