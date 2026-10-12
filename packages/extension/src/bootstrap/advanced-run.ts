import type { createSyncStateStore, MappingInput, SyncScope } from '../sync-state-store.js';
import type { AdvancedPlanRecord, AdvancedStepRecord } from '../sync-state/advanced-repository.js';
import type { AdvancedStep, AdvancedParentRef } from './advanced-plan-types.js';
import { digest, type MountFact, type RemoteNodeFact } from './matcher.js';
import { advanceConfirmedPlan } from './advanced-executor.js';
import { executeAdvancedLocalStep, type AdvancedNativeApi } from './advanced-local-executor.js';
import { executeAdvancedRemoteStep, resolveAdvancedReference } from './advanced-remote-executor.js';

type Store = ReturnType<typeof createSyncStateStore>;
export async function activeAdvancedPlan(store: Store, scope: SyncScope): Promise<AdvancedPlanRecord | null> {
  return (await store.listAdvancedPlans(scope)).find((plan) => plan.state !== 'completed') ?? null;
}

/** Reconstruct activation after a crash between atomic plan installation and
 * first-run/mount writes. The only input is the durable confirmed metadata. */
export async function activateAdvancedPlan(store: Store, scope: SyncScope, plan: AdvancedPlanRecord): Promise<void> {
  const metadata = plan.metadata;
  if (metadata.mode !== 'upload' && metadata.mode !== 'download' && metadata.mode !== 'mirror') {
    throw new Error('advanced_plan_corrupt');
  }
  const mounts = metadata.mounts as unknown as readonly MountFact[];
  if (!Array.isArray(mounts) || mounts.length === 0) throw new Error('advanced_plan_corrupt');
  const bindings = await store.listMountBindings(scope);
  const runs = await store.listBootstrapRuns(scope);
  if (runs.some((run) => run.runId === plan.planId)) {
    const recorded = await store.getScope(scope);
    if (mounts.some((mount) => bindings.find((binding) => binding.nativeRootId === mount.nativeRootId)?.status !== 'active')
        || (typeof metadata.boundaryVersion === 'string' && recorded?.boundaryVersion !== metadata.boundaryVersion)) {
      const loaded = await store.readAdvancedPlan(scope, plan.planId);
      const step = loaded?.steps.find((row) => row.state === 'pending' || row.state === 'executing');
      if (step) await store.settleAdvancedStep(scope, plan.planId, step.order,
        { expectedState: step.state, state: 'attention', error: 'advanced_boundary_changed' });
    }
    if (recorded?.firstRun !== 'running') await store.setFirstRun(scope, 'running');
    return;
  }
  for (const mount of mounts) {
    const existing = bindings.find((row) => row.nativeRootId === mount.nativeRootId);
    if (existing?.status === 'active') continue;
    await store.putMountBinding(scope, { mountId: existing?.mountId ?? `mount:${mount.nativeRootId}`,
      nativeRootId: mount.nativeRootId, remoteMountNodeId: mount.remoteMountNodeId ?? null,
      status: 'active', materialized: false, boundaryVersion: String(metadata.boundaryVersion ?? '1'),
      ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
      ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}) });
  }
  if (!runs.some((run) => run.runId === plan.planId)) await store.putBootstrapRun(scope, {
    runId: plan.planId, confirmationId: String(metadata.confirmationId), phase: 'syncing',
    bootstrapMode: metadata.mode, destructiveConfirmed: true, reportDigest: plan.digest, updatedAt: Date.now(),
    treeDigest: String(metadata.treeDigest), libraryId: scope.collectionId,
    ...(typeof metadata.previewId === 'string' ? { previewId: metadata.previewId } : {}),
    ...(typeof metadata.boundaryVersion === 'string' ? { confirmationVersion: metadata.boundaryVersion } : {}),
    ...(typeof metadata.remoteCursor === 'string' ? { snapshotCursor: metadata.remoteCursor } : {}),
  });
  if ((await store.getScope(scope))?.firstRun !== 'running') await store.setFirstRun(scope, 'running');
}

export async function projectAdvancedSnapshot(store: Store, scope: SyncScope,
  staged: readonly MappingInput[]): Promise<readonly MappingInput[] | null> {
  const active = await activeAdvancedPlan(store, scope); if (!active) return null;
  const loaded = await store.readAdvancedPlan(scope, active.planId); if (!loaded) throw new Error('advanced_plan_missing');
  const recovery = (await store.exportScope(scope)).recovery;
  if (recovery && (recovery.snapshotId !== active.metadata.remoteSnapshotId
      || recovery.revision !== active.metadata.remoteRevision || recovery.syncCursor !== active.metadata.remoteCursor)) {
    const pending = loaded.steps.find((step) => step.state === 'pending' || step.state === 'executing');
    if (pending) await store.settleAdvancedStep(scope, active.planId, pending.order,
      { expectedState: pending.state, state: 'attention', error: 'advanced_snapshot_changed' });
    throw new Error('advanced_snapshot_changed');
  }
  const seeds = snapshotSeeds(loaded.steps);
  const mounts = active.metadata.mounts as unknown as readonly MountFact[];
  const mountByRemote = new Map(mounts.flatMap((mount) => {
    const id = mount.remoteMountNodeId ?? [...seeds.values()].find((seed) =>
      mount.rootRole && seed.fact.folderRole === mount.rootRole)?.fact.nodeId;
    return id ? [[id, mount] as const] : [];
  }));
  const nativeByColp = new Map([...seeds.values()].filter((seed) => seed.nativeId)
    .map((seed) => [seed.fact.nodeId, seed.nativeId!]));
  for (const [id, mount] of mountByRemote) nativeByColp.set(id, mount.nativeRootId);
  const result = staged.map((mapping): MappingInput => {
    const seed = seeds.get(mapping.colpId); const nativeId = nativeByColp.get(mapping.colpId);
    const mount = mountedAncestor(mapping.colpId, seeds, mountByRemote);
    if (!nativeId || !mount || seed?.fact.managed || seed?.fact.privateLocal) {
      return { ...mapping, nativeId: `unmounted:${mapping.colpId}`, rootNativeId: `unmounted:${mapping.colpId}` };
    }
    const isMount = mountByRemote.has(mapping.colpId);
    const parentId = seed?.fact.parentId;
    const { parentNativeId: _parentNative, parentColpId: _parentColp, ...base } = mapping;
    return { ...base, nativeId, rootNativeId: mount.nativeRootId,
      mountId: `mount:${mount.nativeRootId}`, ...(mount.rootRole ? { rootRole: mount.rootRole } : { rootRole: 'custom' }),
      ...(!isMount && parentId ? { parentColpId: parentId,
        parentNativeId: nativeByColp.get(parentId) ?? `unmounted:${parentId}` } : {}) };
  });
  for (const [nodeId, mount] of mountByRemote) {
    const binding = (await store.listMountBindings(scope)).find((row) => row.nativeRootId === mount.nativeRootId);
    if (binding) {
      const { scopeKey: _key, ...value } = binding;
      await store.putMountBinding(scope, { ...value, remoteMountNodeId: nodeId, materialized: true, status: 'active' });
    }
  }
  return result;
}

export async function executeActiveAdvancedPlan(store: Store, scope: SyncScope, api: AdvancedNativeApi,
  refreshRemoteFacts?: () => Promise<readonly RemoteNodeFact[]>, assertAuthority?: () => Promise<void>): Promise<boolean> {
  const plan = await activeAdvancedPlan(store, scope); if (!plan) return false;
  const result = await advanceConfirmedPlan({ store, scope, planId: plan.planId, assertAuthority, adapter: {
    async apply(record, completed) {
      if (record.definition.kind === 'snapshot-fact') {
        const fact = record.definition.fact as unknown as RemoteNodeFact;
        return { state: 'complete', evidence: { targetId: fact.nodeId, revision: fact.revision,
          ...(typeof record.definition.nativeId === 'string' ? { nativeId: record.definition.nativeId } : {}),
          ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) } };
      }
      const step = record.definition as unknown as AdvancedStep;
      if (step.side === 'remote') return executeAdvancedRemoteStep({ store, scope, step, planId: plan.planId,
        completed, refreshRemoteFacts });
      if (step.side === 'local') return executeAdvancedLocalStep({ store, scope, api, record, step, completed });
      throw new Error('advanced_step_invalid');
    },
  } });
  const run = (await store.listBootstrapRuns(scope)).find((row) => row.runId === plan.planId);
  if (run) await store.putBootstrapRun(scope, { ...run, phase: result === 'completed' ? 'completed'
    : result === 'attention' ? 'needs_attention' : 'syncing', updatedAt: Date.now(),
    ...(result === 'attention' ? { retryReason: 'advanced_step_changed' } : {}) });
  if (result === 'completed') await store.setFirstRun(scope, 'completed');
  return true;
}

export async function captureAdvancedCreate(store: Store, scope: SyncScope, nativeId: string,
  node: { readonly parentId?: string; readonly title: string; readonly url?: string }): Promise<boolean> {
  const plan = await activeAdvancedPlan(store, scope);
  if (!plan) {
    // Chrome may deliver onCreated after the final API promise and plan commit.
    // A terminal observed native ID is durable evidence, unlike a URL match.
    const mapping = await store.getMappingByNativeId(scope, nativeId);
    if (!mapping) return false;
    for (const prior of await store.listAdvancedPlans(scope)) {
      const loaded = await store.readAdvancedPlan(scope, prior.planId);
      if (loaded?.steps.some((step) => step.state === 'terminal' && step.definition.side === 'local'
          && step.definition.action === 'create' && step.evidence?.nativeId === nativeId
          && step.evidence.targetId === mapping.colpId)) return true;
    }
    return false;
  }
  const loaded = await store.readAdvancedPlan(scope, plan.planId); if (!loaded) return false;
  const completed = loaded.steps.filter((step) => step.state === 'terminal');
  let observed = false;
  for (const record of loaded.steps) {
    if (record.definition.side !== 'local' || record.definition.action !== 'create') continue;
    // The executor settles a step as soon as create() returns, often before Chrome delivers onCreated.
    // Its recorded native ID is the same durable proof used after the plan completes.
    if (record.state === 'terminal') { if (record.evidence?.nativeId === nativeId) observed = true; continue; }
    if (record.state !== 'executing') continue;
    const step = record.definition as unknown as Extract<AdvancedStep, { side: 'local'; action: 'create' }>;
    const parentId = resolveAdvancedReference(step.parent as AdvancedParentRef, completed, 'nativeId');
    if (parentId !== node.parentId || node.title !== step.payload.node.title
        || (node.url ?? '') !== (step.payload.node.url ?? '')) continue;
    observed = true;
    await store.settleAdvancedStep(scope, record.planId, record.order,
      { expectedState: 'executing', state: 'executing', observedNativeId: nativeId }).catch((error: unknown) => {
        if (!(error instanceof Error) || !['advanced_step_stale', 'advanced_step_transition_invalid',
          'advanced_plan_completed'].includes(error.message)) throw error;
      });
  }
  return observed;
}

interface SnapshotSeed { readonly fact: RemoteNodeFact; readonly nativeId: string | null }
function snapshotSeeds(steps: readonly AdvancedStepRecord[]): Map<string, SnapshotSeed> {
  return new Map(steps.filter((step) => step.definition.kind === 'snapshot-fact').map((step) => {
    const fact = step.definition.fact as unknown as RemoteNodeFact;
    return [fact.nodeId, { fact, nativeId: typeof step.definition.nativeId === 'string' ? step.definition.nativeId : null }];
  }));
}
function mountedAncestor(id: string, seeds: ReadonlyMap<string, SnapshotSeed>, mounts: ReadonlyMap<string, MountFact>) {
  const seen = new Set<string>(); let current: string | null = id;
  while (current && !seen.has(current)) {
    if (mounts.has(current)) return mounts.get(current);
    seen.add(current); current = seeds.get(current)?.fact.parentId ?? null;
  }
  return undefined;
}

export function advancedFactsDigest(facts: readonly RemoteNodeFact[]): string {
  return digest([...facts].sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
}
