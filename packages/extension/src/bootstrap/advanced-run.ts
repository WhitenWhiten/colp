import { persistFirstRunBrowserRoots } from '../sw/first-run-browser-roots.js';
import type { createSyncStateStore, MappingInput, SyncScope } from '../sync-state-store.js';
import type { AdvancedPlanRecord } from '../sync-state/advanced-repository.js';
import { type MountFact, type RemoteNodeFact } from './matcher.js';
import { advanceConfirmedPlan } from './advanced-executor.js';
import { executeAdvancedLocalStep, type AdvancedNativeApi } from './advanced-local-executor.js';
import { executeAdvancedRemoteStep, resolveAdvancedReference } from './advanced-remote-executor.js';
import {
  isAdvancedSnapshotFactDefinition, parseAdvancedPlanMetadata, parseAdvancedStepDefinition,
  type AdvancedPlanMetadata, type AdvancedSnapshotFactDefinition, type AdvancedStepDefinition,
} from './advanced-record-validation.js';

type Store = ReturnType<typeof createSyncStateStore>;
export async function activeAdvancedPlan(store: Store, scope: SyncScope): Promise<AdvancedPlanRecord | null> {
  return (await store.listAdvancedPlans(scope)).find((plan) => plan.state !== 'completed') ?? null;
}

/** Reconstruct activation after a crash between atomic plan installation and
 * first-run/mount writes. The only input is the durable confirmed metadata. */
export async function activateAdvancedPlan(store: Store, scope: SyncScope, plan: AdvancedPlanRecord): Promise<void> {
  const metadata = parseAdvancedPlanMetadata(plan.metadata);
  const mounts = metadata.mounts;
  const boundaryVersion = metadata.boundaryVersion;
  const bindings = await store.listMountBindings(scope);
  await persistAdvancedPrivacy(store, scope, metadata);
  const runs = await store.listBootstrapRuns(scope);
  if (runs.some((run) => run.runId === plan.planId)) {
    const recorded = await store.getScope(scope);
    if (mounts.some((mount) => bindings.find((binding) => binding.nativeRootId === mount.nativeRootId)?.status !== 'active')
        || (boundaryVersion !== undefined && recorded?.boundaryVersion !== boundaryVersion)) {
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
      nativeRootId: mount.nativeRootId, remoteMountNodeId: mount.remoteMountNodeId,
      status: 'active', materialized: false, boundaryVersion: boundaryVersion ?? '1',
      ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
      ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}) });
  }
  if (!runs.some((run) => run.runId === plan.planId)) await store.putBootstrapRun(scope, {
    runId: plan.planId, confirmationId: metadata.confirmationId, phase: 'syncing',
    bootstrapMode: metadata.mode, destructiveConfirmed: true, reportDigest: plan.digest, updatedAt: Date.now(),
    treeDigest: metadata.treeDigest, libraryId: scope.collectionId,
    ...(metadata.previewId === undefined ? {} : { previewId: metadata.previewId }),
    ...(boundaryVersion === undefined ? {} : { confirmationVersion: boundaryVersion }),
    ...(metadata.remoteCursor === undefined ? {} : { snapshotCursor: metadata.remoteCursor }),
  });
  if ((await store.getScope(scope))?.firstRun !== 'running') await store.setFirstRun(scope, 'running');
}

async function persistAdvancedPrivacy(store: Store, scope: SyncScope, metadata: AdvancedPlanMetadata, completed = false) {
  const { discovered, selectedNativeIds, excludedNativeIds } = metadata;
  // Plans written before mounted-root privacy metadata existed are readable;
  // they simply have no discovered-root selection to persist.
  if (discovered === undefined || selectedNativeIds === undefined || excludedNativeIds === undefined) return;
  const mappings = await store.listMappings(scope);
  const recorded = await store.getScope(scope);
  const existingSelected = mappings.filter(row => recorded?.selectedRoots.includes(row.colpId)).map(row => row.nativeId);
  const existingPrivate = mappings.filter(row => recorded?.privateRoots?.includes(row.colpId)).map(row => row.nativeId);
  const input = { discovered, selectedNativeIds: completed ? selectedNativeIds : existingSelected,
    privateNativeIds: [...new Set([...existingPrivate, ...excludedNativeIds])] };
  if (completed) await persistFirstRunBrowserRoots(store, scope, input);
  else await store.configureBrowserRoots(scope, { ...input, status: 'ready' });
}

export async function projectAdvancedSnapshot(store: Store, scope: SyncScope,
  staged: readonly MappingInput[]): Promise<readonly MappingInput[] | null> {
  const active = await activeAdvancedPlan(store, scope); if (!active) return null;
  const loaded = await store.readAdvancedPlan(scope, active.planId); if (!loaded) throw new Error('advanced_plan_missing');
  const metadata = parseAdvancedPlanMetadata(active.metadata);
  const definitions = loaded.steps.map((record) => parseAdvancedStepDefinition(record.definition));
  const recovery = (await store.exportScope(scope)).recovery;
  if (recovery && (metadata.remoteSnapshotId === undefined || metadata.remoteRevision === undefined
      || metadata.remoteCursor === undefined || recovery.snapshotId !== metadata.remoteSnapshotId
      || recovery.revision !== metadata.remoteRevision || recovery.syncCursor !== metadata.remoteCursor)) {
    const pending = loaded.steps.find((step) => step.state === 'pending' || step.state === 'executing');
    if (pending) await store.settleAdvancedStep(scope, active.planId, pending.order,
      { expectedState: pending.state, state: 'attention', error: 'advanced_snapshot_changed' });
    throw new Error('advanced_snapshot_changed');
  }
  const seeds = snapshotSeeds(definitions);
  const mounts = metadata.mounts;
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
  // Validate every persisted definition before the first transition or side effect.
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  if (!loaded) throw new Error('advanced_plan_missing');
  const metadata = parseAdvancedPlanMetadata(plan.metadata);
  for (const record of loaded.steps) parseAdvancedStepDefinition(record.definition);
  const result = await advanceConfirmedPlan({ store, scope, planId: plan.planId, assertAuthority, adapter: {
    async apply(record, completed) {
      const definition = parseAdvancedStepDefinition(record.definition);
      if (isAdvancedSnapshotFactDefinition(definition)) {
        const fact = definition.fact;
        return { state: 'complete', evidence: { targetId: fact.nodeId, revision: fact.revision,
          ...(definition.nativeId === null ? {} : { nativeId: definition.nativeId }),
          ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) } };
      }
      const step = definition;
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
  if (result === 'completed') {
    await persistAdvancedPrivacy(store, scope, metadata, true);
    await store.setFirstRun(scope, 'completed');
  }
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
  const definitions = loaded.steps.map((record) => parseAdvancedStepDefinition(record.definition));
  const completed = loaded.steps.filter((step) => step.state === 'terminal');
  let observed = false;
  for (const [index, record] of loaded.steps.entries()) {
    const definition = definitions[index]!;
    if (isAdvancedSnapshotFactDefinition(definition) || definition.side !== 'local' || definition.action !== 'create') continue;
    // The executor settles a step as soon as create() returns, often before Chrome delivers onCreated.
    // Its recorded native ID is the same durable proof used after the plan completes.
    if (record.state === 'terminal') { if (record.evidence?.nativeId === nativeId) observed = true; continue; }
    if (record.state !== 'executing') continue;
    const step = definition;
    const parentId = resolveAdvancedReference(step.parent, completed, 'nativeId');
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
function snapshotSeeds(definitions: readonly AdvancedStepDefinition[]): Map<string, SnapshotSeed> {
  return new Map(definitions.filter(isAdvancedSnapshotFactDefinition).map((definition:
    AdvancedSnapshotFactDefinition) => [definition.fact.nodeId, { fact: definition.fact,
    nativeId: definition.nativeId }]));
}
function mountedAncestor(id: string, seeds: ReadonlyMap<string, SnapshotSeed>, mounts: ReadonlyMap<string, MountFact>) {
  const seen = new Set<string>(); let current: string | null = id;
  while (current && !seen.has(current)) {
    if (mounts.has(current)) return mounts.get(current);
    seen.add(current); current = seeds.get(current)?.fact.parentId ?? null;
  }
  return undefined;
}
