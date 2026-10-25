import { digestJson } from './bookmark-event-codec.js';
import { readReplicaRepairCapability } from './replica-repair-capability.js';
import { REPLICA_REBUILD_IDENTITY } from './replica-rebuild-identity.js';
import type { StorageArea, createCredentialStore } from './credential-store.js';
import type { StoredAuthBinding } from './types.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

export const REPLICA_REBUILD_JOURNAL = 'known.sync.replica-rebuild.v1';
export type ReplicaRebuildRequest = { readonly kind: 'known.scope.rebuild.preview' }
  | { readonly kind: 'known.scope.rebuild.cancel'; readonly userGesture: true }
  | { readonly kind: 'known.scope.rebuild.confirm'; readonly userGesture: true;
    readonly replicaId: string; readonly generation: number; readonly revision: number; readonly targetFence: string };
export interface ReplicaRebuildPreview {
  readonly replicaId: string; readonly generation: number; readonly revision: number; readonly queuedOperations: number;
  readonly targetFence: string; readonly scope: SyncScope;
  /** K3: `server_fenced` retires the old replica on the server before archiving it; needs a connection. */
  readonly mode?: 'local' | 'server_fenced';
}
export type ReplicaRebuildResponse = { readonly ok: true; readonly preview: ReplicaRebuildPreview }
  | { readonly ok: true; readonly result: 'setup_required' | 'cancelled' }
  | { readonly ok: false; readonly code: string };
interface RebuildJournal {
  readonly scope: SyncScope; readonly authorityGeneration: number;
  readonly nextBinding: StoredAuthBinding; readonly preview: ReplicaRebuildPreview;
}
/** How the old replica was taken off the server: just now, or it already was. */
export type ReplicaFenceOutcome = 'fenced' | 'already_retired';
export interface ReplicaRebuildDeps {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'getEngineState' | 'listQueue'
    | 'retireScope' | 'exportScope' | 'exportArchive'> & Partial<Pick<ReturnType<typeof createSyncStateStore>,
      'getQueueReceipt' | 'listPullIssues' | 'listLocalIssues' | 'listApplyIntents' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'
      | 'listUnreadableQueue'>>;
  readonly credentials: ReturnType<typeof createCredentialStore>;
  readonly journal: StorageArea;
  currentScope(): Promise<SyncScope>;
  ensureScope(): Promise<SyncScope>;
  resetRuntime(): void;
  /**
   * Retires the old replica on the server so no late upload can commit after it is archived (K3, B-13).
   * Throws a stable code (`offline`, `fence_refused`, ...) when it cannot. Absent: only a Reset that does
   * not need the fence is possible.
   */
  fence?(scope: SyncScope): Promise<ReplicaFenceOutcome>;
}

export function validReplicaRebuildRequest(value: unknown): value is ReplicaRebuildRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>; const keys = Object.keys(row);
  if (row.kind === 'known.scope.rebuild.preview') return keys.length === 1;
  if (row.kind === 'known.scope.rebuild.cancel') return keys.length === 2 && row.userGesture === true;
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
    if (authority.revoked || authority.generation !== value.authorityGeneration
        || credential && (credential.subject !== value.scope.accountId || credential.serverOrigin !== value.scope.serverOrigin)) {
      await deps.journal.remove(REPLICA_REBUILD_JOURNAL); return undefined;
    }
    // The journal is durable; the credential is cleared on browser restart.
    // Its temporary absence does not revoke the owner's confirmed reset.
    return value;
  }
  /** The old scope is already archived: the reset can no longer be cancelled, only finished. */
  const archived = (scope: SyncScope) => deps.store.exportArchive(scope).then(() => true, () => false);
  async function inspect(serverRetiredScope?: SyncScope): Promise<{ scope: SyncScope; preview: ReplicaRebuildPreview }> {
    const scope = await deps.currentScope();
    const credential = await deps.credentials.loadCredential();
    if (credential?.subject !== scope.accountId || credential.serverOrigin !== scope.serverOrigin) throw new Error('account_switch');
    const authority = await deps.credentials.fence.assertWritable();
    if (serverRetiredScope && digestJson({ ...serverRetiredScope }) !== digestJson({ ...scope })) throw new Error('stale_ref');
    // The server fence makes raw archival safe even when one corrupt record
    // prevents the normal diagnostics/queue validators from reading the scope.
    // Never delete that evidence merely to get past its failed validation.
    const capability = serverRetiredScope ? undefined : await readReplicaRepairCapability(deps.store, scope);
    if (capability && !capability.rebuildAvailable) throw new Error(capability.rebuildBlockedReason ?? capability.reason ?? 'action_unavailable');
    const archive = serverRetiredScope || capability?.unreadable ? await deps.store.exportScope(scope).catch(() => undefined) : undefined;
    const rawEngine = archive?.engine;
    const revision = capability?.state?.revision ?? (rawEngine && typeof rawEngine === 'object' && 'revision' in rawEngine
      ? rawEngine.revision : undefined);
    const queuedOperations = capability?.unreadable ? archive?.queue.length ?? 0 : capability?.queuedOperations ?? archive?.queue.length ?? 0;
    return { scope, preview: { replicaId: scope.replicaId, generation: scope.generation,
      revision: Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0,
      queuedOperations, scope, targetFence: digestJson({ scope: { ...scope }, authority: authority.generation }),
      mode: serverRetiredScope ? 'server_fenced' : capability?.rebuildMode ?? 'local' } };
  }
  async function resume(): Promise<boolean> {
    const plan = await pending(); if (!plan) return false;
    if (!await deps.credentials.loadCredential()) throw new Error('not_connected');
    const current = await deps.currentScope();
    const expected = current.replicaId === plan.nextBinding.replicaId
      ? { ...plan.scope, replicaId: plan.nextBinding.replicaId, generation: Number(plan.nextBinding.generation) } : plan.scope;
    if (digestJson({ ...current }) !== digestJson({ ...expected })) throw new Error('stale_ref');
    const binding = await deps.credentials.loadBinding();
    if (binding?.replicaId !== plan.scope.replicaId && binding?.replicaId !== plan.nextBinding.replicaId) {
      throw new Error('stale_ref');
    }
    await deps.credentials.fence.assertWritable(plan.authorityGeneration);
    if (await deps.store.getScope(plan.scope)) {
      await deps.store.retireScope(plan.scope, { retiredAt: Date.now(), reason: 'user_replica_rebuild' });
    } else {
      // Never rotate authority without the old queue's durable archive.
      await deps.store.exportArchive(plan.scope);
    }
    await deps.credentials.replaceBindingForRebuild(plan.authorityGeneration, plan.scope.replicaId, plan.nextBinding);
    deps.resetRuntime();
    const rebuilt = await deps.ensureScope();
    if (rebuilt.replicaId !== plan.nextBinding.replicaId || rebuilt.accountId !== plan.scope.accountId
        || rebuilt.collectionId !== plan.scope.collectionId) throw new Error('scope_mismatch');
    if (!await deps.store.getScope(rebuilt)) throw new Error('scope_not_found');
    await deps.credentials.fence.assertWritable(plan.authorityGeneration);
    await deps.journal.set({ [REPLICA_REBUILD_IDENTITY]: { target: rebuilt, source: plan.scope } });
    await deps.journal.remove(REPLICA_REBUILD_JOURNAL);
    return true;
  }
  /** W2A-02: a reset that cannot finish and has changed nothing yet can be given up; once archived it can only finish. */
  async function cancel(): Promise<ReplicaRebuildResponse> {
    const plan = await pending();
    if (plan && await archived(plan.scope)) throw new Error('rebuild_not_cancellable');
    if (plan) await deps.journal.remove(REPLICA_REBUILD_JOURNAL);
    return { ok: true, result: 'cancelled' };
  }
  async function handle(message: ReplicaRebuildRequest, serverRetiredScope?: SyncScope): Promise<ReplicaRebuildResponse> {
    try {
      if (message.kind === 'known.scope.rebuild.cancel') return await cancel();
      const existing = await pending();
      if (message.kind === 'known.scope.rebuild.preview') {
        return { ok: true, preview: existing?.preview ?? (await inspect(serverRetiredScope)).preview };
      }
      const inspected = existing ? { scope: existing.scope, preview: existing.preview } : await inspect(serverRetiredScope);
      if (inspected.preview.replicaId !== message.replicaId || inspected.preview.generation !== message.generation
          || inspected.preview.revision !== message.revision || inspected.preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing && (await inspect(serverRetiredScope)).preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing) {
        const authority = await deps.credentials.fence.capture();
        const binding = await deps.credentials.loadBinding();
        if (binding?.replicaId !== inspected.scope.replicaId) throw new Error('stale_ref');
        await fenceOldReplica(inspected, serverRetiredScope);
        await deps.journal.set({ [REPLICA_REBUILD_JOURNAL]: { ...inspected, authorityGeneration: authority.generation,
          nextBinding: { ...binding, replicaId: `replica-${crypto.randomUUID()}`, generation: '1' } } satisfies RebuildJournal });
      }
      try { await resume(); } catch (error) {
        // W2A-02: a reset that failed before anything was archived leaves no journal behind to stop every wake.
        if (!existing && !await archived(inspected.scope)) await deps.journal.remove(REPLICA_REBUILD_JOURNAL);
        throw error;
      }
      return { ok: true, result: 'setup_required' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { ok: false, code: /^[a-z][a-z0-9_:-]{0,63}$/u.test(code) ? code : 'rebuild_failed' };
    }
  }
  /**
   * K3 / B-13: the old replica leaves the server before it is archived. Required when an upload may
   * already be there; otherwise best effort, so a replaced replica does not linger active on the server.
   */
  async function fenceOldReplica(inspected: { scope: SyncScope; preview: ReplicaRebuildPreview }, serverRetiredScope?: SyncScope) {
    if (serverRetiredScope) return; // the server fenced it already (owner-confirmed Reset in the Sync center)
    const required = inspected.preview.mode === 'server_fenced';
    if (!deps.fence) { if (required) throw new Error('fence_unavailable'); return; }
    try { await deps.fence(inspected.scope); }
    catch (error) { if (required) throw error; }
  }
  return { handle: (message: ReplicaRebuildRequest) => handle(message), resume,
    // Only the authenticated health-command runner supplies this server fence.
    // It is deliberately absent from the runtime message/request schema.
    rebuildServerRetired: (scope: SyncScope) => runReplicaRebuildCommand(message => handle(message, scope), scope),
    hasPending: async () => Boolean(await pending()),
    /** A pending reset can be given up only while nothing has been archived. */
    canCancelPending: async () => { const plan = await pending(); return plan !== undefined && !await archived(plan.scope); } };
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
