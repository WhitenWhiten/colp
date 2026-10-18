import { digestJson } from './bookmark-event-codec.js';
import { readReplicaRepairCapability } from './replica-repair-capability.js';
import type { StorageArea, createCredentialStore } from './credential-store.js';
import type { StoredAuthBinding } from './types.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

export const REPLICA_REBUILD_JOURNAL = 'known.sync.replica-rebuild.v1';
export type ReplicaRebuildRequest = { readonly kind: 'known.scope.rebuild.preview' }
  | { readonly kind: 'known.scope.rebuild.confirm'; readonly userGesture: true;
    readonly replicaId: string; readonly generation: number; readonly revision: number; readonly targetFence: string };
export interface ReplicaRebuildPreview {
  readonly replicaId: string; readonly generation: number; readonly revision: number; readonly queuedOperations: number;
  readonly targetFence: string; readonly scope: SyncScope;
}
export type ReplicaRebuildResponse = { readonly ok: true; readonly preview: ReplicaRebuildPreview }
  | { readonly ok: true; readonly result: 'setup_required' }
  | { readonly ok: false; readonly code: string };
interface RebuildJournal {
  readonly scope: SyncScope; readonly authorityGeneration: number;
  readonly nextBinding: StoredAuthBinding; readonly preview: ReplicaRebuildPreview;
}
export interface ReplicaRebuildDeps {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'getEngineState' | 'listQueue'
    | 'retireScope' | 'exportArchive'> & Partial<Pick<ReturnType<typeof createSyncStateStore>,
      'getQueueReceipt' | 'listPullIssues' | 'listLocalIssues' | 'listApplyIntents' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'>>;
  readonly credentials: ReturnType<typeof createCredentialStore>;
  readonly journal: StorageArea;
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
    const capability = await readReplicaRepairCapability(deps.store, scope);
    if (!capability.rebuildAvailable) throw new Error(capability.reason ?? 'action_unavailable');
    const { state, queuedOperations } = capability;
    return { scope, preview: { replicaId: scope.replicaId, generation: scope.generation,
      revision: state?.revision ?? 0, queuedOperations, scope, targetFence: digestJson({ scope: { ...scope }, authority: authority.generation }) } };
  }
  async function resume(): Promise<boolean> {
    const plan = await pending(); if (!plan) return false;
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
    await deps.journal.remove(REPLICA_REBUILD_JOURNAL);
    return true;
  }
  async function handle(message: ReplicaRebuildRequest): Promise<ReplicaRebuildResponse> {
    try {
      const existing = await pending();
      if (message.kind === 'known.scope.rebuild.preview') {
        return { ok: true, preview: existing?.preview ?? (await inspect()).preview };
      }
      const inspected = existing ? { scope: existing.scope, preview: existing.preview } : await inspect();
      if (inspected.preview.replicaId !== message.replicaId || inspected.preview.generation !== message.generation
          || inspected.preview.revision !== message.revision || inspected.preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing && (await inspect()).preview.targetFence !== message.targetFence) throw new Error('stale_ref');
      if (!existing) {
        const authority = await deps.credentials.fence.capture();
        const binding = await deps.credentials.loadBinding();
        if (binding?.replicaId !== inspected.scope.replicaId) throw new Error('stale_ref');
        await deps.journal.set({ [REPLICA_REBUILD_JOURNAL]: { ...inspected, authorityGeneration: authority.generation,
          nextBinding: { ...binding, replicaId: `replica-${crypto.randomUUID()}`, generation: '1' } } satisfies RebuildJournal });
      }
      await resume(); return { ok: true, result: 'setup_required' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { ok: false, code: /^[a-z][a-z0-9_:-]{0,63}$/u.test(code) ? code : 'rebuild_failed' };
    }
  }
  return { handle, resume, hasPending: async () => Boolean(await pending()) };
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
