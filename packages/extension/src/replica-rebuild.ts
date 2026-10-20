import { digestJson } from './bookmark-event-codec.js';
import { readReplicaRepairCapability } from './replica-repair-capability.js';
import { projectUnresolvedNativeWait } from './native-wait-open.js';
import type { StorageArea, createCredentialStore } from './credential-store.js';
import type { StoredAuthBinding } from './types.js';
import type { IntentRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { ReplicaRetirementIntent, ReplicaRetirementTransport } from './replica-retirement.js';

export const REPLICA_REBUILD_JOURNAL = 'known.sync.replica-rebuild.v1';
export type ReplicaRebuildRequest = { readonly kind: 'known.scope.rebuild.preview' }
  | { readonly kind: 'known.scope.rebuild.confirm'; readonly userGesture: true;
    readonly replicaId: string; readonly generation: number; readonly revision: number; readonly targetFence: string };
export interface ReplicaRebuildPreview {
  readonly replicaId: string; readonly generation: number; readonly revision: number; readonly queuedOperations: number;
  readonly targetFence: string; readonly scope: SyncScope;
  readonly retirementRequired?: true;
}
export type ReplicaRebuildResponse = { readonly ok: true; readonly preview: ReplicaRebuildPreview }
  | { readonly ok: true; readonly result: 'setup_required' }
  | { readonly ok: false; readonly code: string };
export type PendingReplicaRebuild = false | { readonly available: boolean; readonly reason?: string };
interface RebuildJournal {
  readonly scope: SyncScope; readonly authorityGeneration: number;
  readonly nextBinding: StoredAuthBinding; readonly preview: ReplicaRebuildPreview;
  readonly retirement?: ReplicaRetirementIntent;
}
export interface ReplicaRebuildDeps {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'getEngineState' | 'listQueue'
    | 'retireScope' | 'exportArchive'> & Partial<Pick<ReturnType<typeof createSyncStateStore>,
      'getQueueReceipt' | 'listPullIssues' | 'listLocalIssues' | 'listApplyIntents' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'>>;
  readonly credentials: ReturnType<typeof createCredentialStore>;
  readonly journal: StorageArea;
  readonly serverRetirement?: ReplicaRetirementTransport;
  currentScope(): Promise<SyncScope>;
  ensureScope(): Promise<SyncScope>;
  resetRuntime(): void;
}

export function validReplicaRebuildRequest(value: unknown): value is ReplicaRebuildRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>; const keys = Object.keys(row);
  if (row.kind === 'known.scope.rebuild.preview') return keys.length === 1;
  return row.kind === 'known.scope.rebuild.confirm' && row.userGesture === true
    && keys.length === 6 && keys.every(key => ['kind', 'userGesture', 'replicaId', 'generation', 'revision', 'targetFence'].includes(key))
    && typeof row.targetFence === 'string' && /^sha256:[a-f0-9]{64}$/u.test(row.targetFence)
    && typeof row.replicaId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(row.replicaId)
    && Number.isSafeInteger(row.generation) && Number(row.generation) > 0
    && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0;
}

/** The host serializes confirm/resume with engine work; every boundary is restartable. */
export function createReplicaRebuilder(deps: ReplicaRebuildDeps) {
  async function pending(): Promise<RebuildJournal | undefined> {
    const value = (await deps.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL] as RebuildJournal | undefined;
    if (!value) return undefined;
    const credential = await deps.credentials.loadCredential();
    const authority = await deps.credentials.fence.read();
    if (value.retirement) {
      // A browser restart empties session storage. A later login changes the
      // generation. Neither proves this retirement completed: keep its exact
      // identity, and require a fresh confirmation when authority changed.
      return value;
    }
    if (authority.revoked || authority.generation !== value.authorityGeneration
        || !credential?.subject || credential.subject !== value.scope.accountId || credential.serverOrigin !== value.scope.serverOrigin) {
      await deps.journal.remove(REPLICA_REBUILD_JOURNAL); return undefined;
    }
    return value;
  }
  async function inspect(): Promise<{ scope: SyncScope; preview: ReplicaRebuildPreview }> {
    const scope = await deps.currentScope();
    const credential = await deps.credentials.loadCredential();
    if (credential?.subject !== scope.accountId || credential.serverOrigin !== scope.serverOrigin) throw new Error('account_switch');
    const authority = await deps.credentials.fence.assertWritable();
    const capability = await readReplicaRepairCapability(deps.store, scope, undefined,
      { serverRetirement: deps.serverRetirement !== undefined });
    if (!capability.rebuildAvailable) throw new Error(capability.reason ?? 'action_unavailable');
    const { state, queuedOperations } = capability;
    return { scope, preview: { replicaId: scope.replicaId, generation: scope.generation,
      revision: state?.revision ?? 0, queuedOperations, scope,
      ...(capability.retirementRequired ? { retirementRequired: true as const } : {}),
      targetFence: digestJson({ scope: { ...scope }, authority: authority.generation }) } };
  }
  async function pendingPreview(plan: RebuildJournal): Promise<ReplicaRebuildPreview> {
    if (!plan.retirement) return plan.preview;
    const authority = await deps.credentials.fence.read();
    const credential = await deps.credentials.loadCredential();
    if (authority.revoked || !credential) throw new Error('rebuild_authentication_required');
    if (credential.subject !== plan.scope.accountId || credential.serverOrigin !== plan.scope.serverOrigin) throw new Error('rebuild_other_account_pending');
    const capability = await pendingCapability(plan);
    if (!capability.available) throw new Error(capability.reason);
    const live = await deps.store.getScope(plan.scope)
      ? await readReplicaRepairCapability(deps.store, plan.scope, undefined, { serverRetirement: true }) : undefined;
    // Once archived, retain the count confirmed for the original scope. While
    // it is live, use the same status-filtered, paged count as the first preview.
    return { ...plan.preview, revision: live?.state?.revision ?? plan.preview.revision,
      ...(live ? { queuedOperations: live.queuedOperations } : {}),
      targetFence: digestJson({ scope: { ...plan.scope }, authority: authority.generation }) };
  }
  async function resume(): Promise<boolean> {
    let plan = await pending(); if (!plan) return false;
    if (plan.retirement && !await deps.credentials.loadCredential()) {
      try { await deps.serverRetirement?.restoreCredential(); }
      catch { throw new Error('rebuild_authentication_required'); }
    }
    if (plan.retirement) {
      const live = await deps.credentials.fence.read();
      const credential = await deps.credentials.loadCredential();
      // Keep another account's unconfirmed request, without stalling this
      // account's independent engine or making its credentials authorize it.
      if (credential && (credential.subject !== plan.scope.accountId || credential.serverOrigin !== plan.scope.serverOrigin)) return false;
      if (live.revoked || live.generation !== plan.authorityGeneration || !credential) throw new Error('rebuild_authentication_required');
    }
    const binding = await deps.credentials.loadBinding();
    if (binding?.replicaId !== plan.scope.replicaId && binding?.replicaId !== plan.nextBinding.replicaId) {
      throw new Error('stale_ref');
    }
    if (binding.browserProfileId !== plan.scope.browserProfileId) throw new Error('stale_ref');
    if (binding.replicaId === plan.nextBinding.replicaId) {
      // A crash can leave the new binding without a Session or IDB scope. The
      // old durable archive, not a newly minted Session, proves that rotation.
      await deps.store.exportArchive(plan.scope);
    } else if (digestJson({ ...await deps.currentScope() }) !== digestJson({ ...plan.scope })) throw new Error('stale_ref');
    await deps.credentials.fence.assertWritable(plan.authorityGeneration);
    if (plan.retirement && !plan.retirement.confirmed) {
      if (!deps.serverRetirement) throw new Error('retirement_pending');
      await assertNativeSettled(plan);
      await deps.serverRetirement.confirm(plan.scope, plan.retirement, plan.authorityGeneration);
      await deps.credentials.fence.assertWritable(plan.authorityGeneration);
      plan = { ...plan, retirement: { ...plan.retirement, confirmed: true } };
      // This write precedes local archive/rotation. If it fails, a restart
      // repeats the same DELETE; the server replays its retirement receipt.
      await deps.journal.set({ [REPLICA_REBUILD_JOURNAL]: plan });
      await deps.credentials.fence.assertWritable(plan.authorityGeneration);
    }
    if (await deps.store.getScope(plan.scope)) {
      await assertNativeSettled(plan);
      await deps.store.retireScope(plan.scope, { retiredAt: Date.now(), reason: 'user_replica_rebuild' });
    } else {
      // Never rotate authority without the old queue's durable archive.
      await assertNativeSettled(plan);
    }
    await deps.credentials.replaceBindingForRebuild(plan.authorityGeneration, plan.scope.replicaId, plan.nextBinding);
    deps.resetRuntime();
    const rebuilt = await deps.ensureScope();
    if (digestJson({ ...rebuilt }) !== digestJson({ ...plan.scope, replicaId: plan.nextBinding.replicaId,
      generation: Number(plan.nextBinding.generation) })) throw new Error('scope_mismatch');
    if (!await deps.store.getScope(rebuilt)) throw new Error('scope_not_found');
    await deps.credentials.fence.assertWritable(plan.authorityGeneration);
    await deps.journal.remove(REPLICA_REBUILD_JOURNAL);
    return true;
  }
  async function handle(message: ReplicaRebuildRequest): Promise<ReplicaRebuildResponse> {
    try {
      const existing = await pending();
      if (message.kind === 'known.scope.rebuild.preview') {
        return { ok: true, preview: existing ? await pendingPreview(existing) : (await inspect()).preview };
      }
      const inspected = existing ? { scope: existing.scope, preview: await pendingPreview(existing) } : await inspect();
      if (inspected.preview.replicaId !== message.replicaId || inspected.preview.generation !== message.generation
          || inspected.preview.revision !== message.revision || inspected.preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing && (await inspect()).preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing) {
        const authority = await deps.credentials.fence.capture();
        const binding = await deps.credentials.loadBinding();
        if (binding?.replicaId !== inspected.scope.replicaId) throw new Error('stale_ref');
        const retirement = inspected.preview.retirementRequired
          ? await deps.serverRetirement!.prepare(inspected.scope, authority.generation) : undefined;
        await deps.credentials.fence.assertWritable(authority.generation);
        await deps.journal.set({ [REPLICA_REBUILD_JOURNAL]: { ...inspected, authorityGeneration: authority.generation,
          ...(retirement ? { retirement } : {}),
          nextBinding: { ...binding, replicaId: `replica-${crypto.randomUUID()}`, generation: '1' } } satisfies RebuildJournal });
      } else if (existing.retirement) {
        const authority = await deps.credentials.fence.assertWritable();
        if (!await deps.credentials.loadBinding()) {
          // An authentication failure can clear the active binding. Only an
          // explicit confirmation for the same account may restore this target.
          await deps.credentials.restoreBinding({ replicaId: existing.scope.replicaId,
            browserProfileId: existing.scope.browserProfileId, generation: String(existing.scope.generation) }, authority.generation);
        }
        // The user reviewed this same retained request under the current login.
        // Updating authority never replaces its server Session or idempotency key.
        if (!deps.serverRetirement) throw new Error('retirement_pending');
        const retirement = await deps.serverRetirement.reconfirm(existing.scope, existing.retirement, authority.generation);
        await deps.credentials.fence.assertWritable(authority.generation);
        await deps.journal.set({ [REPLICA_REBUILD_JOURNAL]: { ...existing,
          authorityGeneration: authority.generation, preview: inspected.preview, retirement } satisfies RebuildJournal });
      }
      await resume(); return { ok: true, result: 'setup_required' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { ok: false, code: /^[a-z][a-z0-9_:-]{0,63}$/u.test(code) ? code : 'rebuild_failed' };
    }
  }
  async function assertNativeSettled(plan: RebuildJournal) {
    if (await nativeUnknown(plan.scope)) throw new Error('native_outcome_unsettled');
  }
  async function nativeUnknown(scope: SyncScope): Promise<boolean> {
    if (await deps.store.getScope(scope)) {
      const capability = await readReplicaRepairCapability(deps.store, scope, undefined, { serverRetirement: true });
      return capability.reason === 'native_outcome_unsettled';
    }
    // Logout may have archived the scope while a DELETE response was missing.
    // Server retirement cannot settle an unrelated, unknown Chrome mutation.
    const archive = await deps.store.exportArchive(scope);
    const events = new Map((archive.pullEvents as { eventId: string; state: unknown }[]).map(row => [row.eventId, row.state]));
    return (archive.intents as IntentRecord[]).some(intent => intent.nativeResult !== 'waiting_dependency'
      && projectUnresolvedNativeWait(intent, intent.eventId ? events.get(intent.eventId) : undefined));
  }
  async function pendingCapability(plan: RebuildJournal): Promise<Exclude<PendingReplicaRebuild, false>> {
    if (await nativeUnknown(plan.scope)) return { available: false, reason: 'native_outcome_unsettled' };
    const authority = await deps.credentials.fence.read();
    const credential = await deps.credentials.loadCredential();
    return authority.revoked || !credential ? { available: false, reason: 'rebuild_authentication_required' }
      : { available: true };
  }
  async function pendingStatus(): Promise<PendingReplicaRebuild> {
    const plan = await pending(); if (!plan) return false;
    const credential = await deps.credentials.loadCredential();
    if (credential && (credential.subject !== plan.scope.accountId || credential.serverOrigin !== plan.scope.serverOrigin)) return false;
    return pendingCapability(plan);
  }
  return { handle, resume, pendingStatus, hasPending: async () => Boolean(await pendingStatus()) };
}

/** Session refresh cannot replace a retirement's pinned target before local rotation. */
export async function pendingRebuildBlocksSession(journal: StorageArea,
  owner: { readonly subject?: string; readonly serverOrigin: string }, binding: StoredAuthBinding | null): Promise<boolean> {
  const plan = (await journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL] as RebuildJournal | undefined;
  return Boolean(plan?.retirement && plan.scope.accountId === owner.subject && plan.scope.serverOrigin === owner.serverOrigin
    && binding?.replicaId !== plan.nextBinding.replicaId);
}

/** The same checked preview/confirm path serves a web command and local Status. */
export async function runReplicaRebuildCommand(handle: (request: ReplicaRebuildRequest) => Promise<ReplicaRebuildResponse>, target?: SyncScope) {
  const preview = await handle({ kind: 'known.scope.rebuild.preview' });
  if (!preview.ok) return { outcome: 'failed' as const, code: preview.code };
  if (!('preview' in preview)) return { outcome: 'failed' as const, code: 'rebuild_failed' };
  if (target && digestJson({ ...target }) !== digestJson({ ...preview.preview.scope })) return { outcome: 'failed' as const, code: 'stale_ref' };
  const result = await handle({ kind: 'known.scope.rebuild.confirm', userGesture: true,
    replicaId: preview.preview.replicaId, generation: preview.preview.generation, revision: preview.preview.revision, targetFence: preview.preview.targetFence });
  return result.ok ? { outcome: 'done' as const, replaced: true as const } : { outcome: 'failed' as const, code: result.code };
}
