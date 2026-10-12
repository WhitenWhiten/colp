import { recordKns09Stop } from './kns-09-release.js';
import type { PullApplierOptions } from './pull-applier-types.js';
import { inheritFrozenEngineFacts } from './sync-state/engine-transition.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

const FREEZE = new Set([
  'pull_page_invalid', 'effect_page_invalid', 'pull_event_duplicate', 'pull_effect_binding_invalid',
  'pull_effect_kind_invalid', 'pull_cursor_chain_invalid', 'pull_source_binding_invalid',
  'unexpected_effect_page', 'anchor_parent_mismatch', 'snapshot_expired', 'sync_cursor_expired',
  'effect_page_transport_unavailable', 'effect_page_failed', 'snapshot_page_missing',
  'deletion_identity_unproven', 'recovery_identity_unproven', 'remote_delete_confirmation_required',
  'need_authority', 'unmounted_restore_repair',
  // F005: a blocked page or a page identity collision is an authority conflict,
  // not a retryable transport failure. Freezing hands the scope to recovery
  // instead of re-pulling the same page with the same cursor forever.
  'pull_page_reuse', 'recovery_required',
  // F005 sibling: the server issued a recovery capability before the final
  // Snapshot page. Only fresh Session authority can re-issue a valid chain.
  'recovery_capability_premature',
  // F005 sibling: the final Snapshot page carried no valid recovery capability, and
  // the engine entered recovery without a Snapshot mandate. Retrying the same
  // authority re-derives the same denial, so freeze until Session authority refreshes.
  'recovery_capability_invalid', 'recovery_authority_invalid',
  // B1: the server re-delivered an identity (eventId / effect page) whose durable
  // bytes disagree. Accepting it would corrupt the page ledger; retrying the same
  // cursor re-derives the same contradiction, so block and freeze instead.
  'pull_event_conflict',
  // Local projection damage has an explicit replica rebuild exit. Session refresh
  // alone does not mandate a server Snapshot; the engine holds this code instead
  // of repeatedly rebasing active authority and replaying the same failed read.
  'pull_apply_target_missing',
  // SR-02 sibling: the parent's children could not be read, so the create's pre-state
  // digest has no honest evidence. Freezing is preferable to digesting an empty (never
  // observed) child list. User-confirmed rebuilding establishes fresh local evidence.
  'pull_apply_evidence_missing',
  'legacy_resolution_sequence_collision',
]);

type FreezeStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'registerScope' | 'getEngineState' | 'transitionEngine'>;

/**
 * F006: the recovery-staging surface a cursor-window escalation needs. Kept apart from
 * `FreezeStore` so narrow structural callers (recovery-guard's projector store) keep compiling;
 * production always passes the full store.
 */
type StagingStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'getEngineState' | 'getRecoveryHeader' | 'listRecoveryNodes' | 'listAckIntents'
  | 'discardRecoveryStaging' | 'putScopeDiagnostic' | 'rejectBootstrapAckAndRequireAuthorityRefresh'>;

/**
 * Codes whose authority window behind the staged cursor can never be re-opened: the server
 * expired the Cursor lineage (`sync_cursor_expired`, also as the `snapshot_<status>_...` shape
 * `snapshotFailure` produces) or the Snapshot materialisation itself (`snapshot_expired`). Every
 * other frozen code keeps its staged chain.
 */
const CURSOR_EXPIRY = new Set(['sync_cursor_expired', 'snapshot_expired']);

export function isCursorExpiryCode(code: string): boolean {
  return CURSOR_EXPIRY.has(code) || code.endsWith('_sync_cursor_expired');
}

/**
 * F006: the durable bootstrap Ack intent acknowledges the very cursor window that just lapsed, so
 * its exact bytes can never be accepted again. `getPendingAckIntent` would keep handing it to
 * every later wake and each resend would freeze the engine again, blocking Pull forever; drop it
 * through the explicit bootstrap reject path (the same entry the `stale_replica` denial uses).
 */
async function discardUnackableBootstrapAck(store: StagingStore, scope: SyncScope, code: string): Promise<boolean> {
  const pending = (await store.listAckIntents(scope))
    .filter((intent) => intent.kind === 'bootstrap' && intent.state === 'pending');
  if (pending.length === 0) return false;
  const engine = await store.getEngineState(scope);
  const sessionId = engine?.sessionId ?? pending[0]!.sessionId;
  const at = Date.now();
  for (const intent of pending) {
    await store.rejectBootstrapAckAndRequireAuthorityRefresh(scope, intent.intentId,
      // SR-06: carry the revision this read observed so a concurrent engine write is not
      // clobbered; with no durable engine row yet, omit it and let the reject create one.
      { sessionId, updatedAt: at, notBefore: at, errorCode: code,
        ...(engine ? { expectedRevision: engine.revision } : {}) });
  }
  await store.putScopeDiagnostic(scope, { kind: 'recovery_bootstrap_ack_discarded', code,
    details: { intentIds: pending.map((intent) => intent.intentId), cursors: pending.map((intent) => intent.cursor) } });
  return true;
}

/**
 * F006: a lapsed window voids the staged recovery chain - its pages, nodes and capability belong
 * to authority that can never be committed in place, so resuming them only freezes again. Drop
 * the staging (and the dead Ack intent bound to it) and journal exactly what was dropped; the
 * freeze that follows still forces the Session refresh, under which the Snapshot is rebuilt from
 * page 0.
 */
export async function discardExpiredRecoveryStaging(store: StagingStore, scope: SyncScope,
  code: string): Promise<boolean> {
  // A retired scope is not writable at all; leave its archived evidence alone.
  if ((await store.getScope(scope))?.lifecycle === 'retired') return false;
  const droppedAck = await discardUnackableBootstrapAck(store, scope, code);
  const header = await store.getRecoveryHeader(scope);
  if (!header) return droppedAck;
  const nodes = await store.listRecoveryNodes(scope);
  await store.discardRecoveryStaging(scope);
  await store.putScopeDiagnostic(scope, { kind: 'recovery_staging_discarded', code, details: {
    snapshotId: header.snapshotId, lastPage: header.lastPage, complete: header.complete,
    nodeCount: nodes.length, capability: header.capability ?? null } });
  return true;
}

export function shouldFreezePullApply(error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  return FREEZE.has(code) || isCursorExpiryCode(code) || code.startsWith('preflight_')
    || code.startsWith('mapping_missing') || code.endsWith('_mapping_missing');
}

export async function freezeScopeRecovery(store: FreezeStore, scope: SyncScope, code: string,
  now: () => number = Date.now): Promise<void> {
  const current = await store.getScope(scope);
  if (!current) throw new Error('scope_not_found');
  // A blocked page already persisted the specific reason, so keep that first, more
  // precise recoveryCode instead of overwriting it with the generic escalation; the
  // scope write is skipped once it is already recovery_required (`recovery_required
  // -> recovery_required` is legal per scope-key.ts, but re-registering would only
  // rewrite the same row). The engine freeze below still runs on every call.
  const recorded = typeof current.metadata?.recoveryCode === 'string' ? current.metadata.recoveryCode : undefined;
  const effective = code === 'recovery_required' && recorded ? recorded : code;
  if (current.lifecycle !== 'recovery_required') {
    const { scopeKey: _scopeKey, ...authority } = current;
    await store.registerScope({ ...authority, lifecycle: 'recovery_required',
      metadata: { ...(current.metadata ?? {}), recoveryCode: effective } });
  }
  const engine = await store.getEngineState(scope);
  const at = now();
  // SR-06: a freeze is a read-modify-write on the engine row, so it must carry the
  // revision it read (a concurrent transition wins with `engine_revision_stale`
  // instead of being silently overwritten) and re-state every optional cursor /
  // connectivity fact the prior row held - `validateEngineState` drops what is not
  // spelled out, and a freeze that erased `lastPublishedCursor` would make
  // `cursorsConverged` and the re-Ack check read a cursor the replica never held.
  await store.transitionEngine(scope, { phase: 'recovery', updatedAt: at, recoveryFrozen: true,
    authorityRefreshRequired: true, notBefore: at, lastError: effective,
    ...inheritFrozenEngineFacts(engine),
    // A first-ever freeze has no prior row; omitting `expectedRevision` keeps the
    // original "create the row" semantics instead of demanding revision 0.
    ...(engine ? { expectedRevision: engine.revision } : {}),
    ...(engine?.sessionId ? { sessionId: engine.sessionId } : {}) });
}

export async function freezePullApply(options: PullApplierOptions, code: string): Promise<void> {
  if (code.includes('cursor')) recordKns09Stop('cursorDivergence', options.scope);
  // F006: a lapsed cursor window leaves the staged chain uncommittable; drop it so the next
  // authority refresh rebuilds the Snapshot from page 0 instead of resuming it forever.
  if (isCursorExpiryCode(code)) await discardExpiredRecoveryStaging(options.store, options.scope, code);
  await freezeScopeRecovery(options.store, options.scope, code, options.now ?? Date.now);
}

export async function withPullFreeze<T>(options: PullApplierOptions, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (shouldFreezePullApply(error)) await freezePullApply(options, error instanceof Error ? error.message : 'recovery_required');
    throw error;
  }
}
