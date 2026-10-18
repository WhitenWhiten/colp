import { isRecoveryPlaceholder } from './pull-mount-apply.js';
import type { PullApplierOptions, PullNode } from './pull-applier-types.js';
import { mappingFor } from './pull-projection.js';
import { pullPageAuthorityStamps, pullPagesOnAuthorityChain } from './sync-state/recovery-repository.js';
import type { IntentRecord, JsonObject, MappingInput } from './sync-state-store.js';
import type { UnknownRecord } from './sync-state/types.js';

export interface PullApplyAuthority {
  readonly lifecycle: string | undefined;
  readonly frozen: boolean;
  readonly authorityRefreshRequired?: boolean;
  readonly snapshotId?: string;
  readonly generation: number;
  readonly attached: ReadonlySet<string>;
  readonly pages: readonly UnknownRecord[];
  readonly intents: ReadonlyMap<string, IntentRecord>;
}

/** lifecycle and recoveryFrozen are separate. Ordinary apply needs both to allow it. */
export async function readPullApplyAuthority(options: PullApplierOptions): Promise<PullApplyAuthority> {
  const [scopeRow, engine, cursorRow, workset] = await Promise.all([
    options.store.getScope(options.scope), options.store.getEngineState(options.scope),
    options.store.getCursor(options.scope), options.store.loadPullApplyWorkset(options.scope)]);
  const { pages, stamps: records, intents } = workset;
  const generation = scopeRow?.generation ?? options.scope.generation;
  const leaseGeneration = scopeRow?.lease.generation;
  const stamps = pullPageAuthorityStamps(records);
  const cursor = cursorRow?.cursor ?? scopeRow?.checkpoint?.cursor ?? '';
  const evidence = cursorRow?.evidence && typeof cursorRow.evidence === 'object'
    ? cursorRow.evidence as UnknownRecord : {};
  const attached = pullPagesOnAuthorityChain(pages, cursor, (page) => {
    const stamp = stamps.get(String(page.pageId));
    if (stamp?.authorityGeneration !== undefined && stamp.authorityGeneration !== generation) return false;
    return !(stamp?.leaseGeneration !== undefined && stamp.leaseGeneration !== leaseGeneration);
  });
  return { lifecycle: scopeRow?.lifecycle, frozen: engine?.recoveryFrozen === true,
    authorityRefreshRequired: engine?.authorityRefreshRequired === true,
    ...(typeof evidence.snapshotId === 'string' ? { snapshotId: evidence.snapshotId } : {}), generation, attached,
    pages, intents: new Map(intents.map((intent) => [intent.intentId, intent])) };
}

export function supersededPullPage(authority: PullApplyAuthority, page: UnknownRecord): boolean {
  if (String(page.state) === 'page_complete') return false;
  return page.handover === 'reconcile' || page.recoveryCode === 'authority_reconcile'
    || !authority.attached.has(String(page.pageId));
}

export function ordinaryPullEventAllowed(authority: PullApplyAuthority, event: UnknownRecord): boolean {
  const page = authority.pages.find((item) => String(item.pageId) === String(event.pageId));
  if (!page || supersededPullPage(authority, page)) return false;
  const intent = typeof event.intentId === 'string' ? authority.intents.get(event.intentId) : undefined;
  if (intent && typeof intent.generation === 'number' && intent.generation !== authority.generation) return false;
  if (authority.lifecycle === 'recovery_required' || authority.lifecycle === 'retired') return false;
  if (authority.frozen && !authority.attached.has(String(page.pageId))) {
    // Snapshot cutover retained this exact unknown invocation. Once its native
    // identity is confirmed, finish that recovery without admitting new work or
    // waiting for the freeze that this very event must release.
    const confirmation = intent?.nativeResultConfirmation;
    return authority.lifecycle === 'active' && authority.authorityRefreshRequired === false && page.state === 'page_complete'
      && typeof authority.snapshotId === 'string' && page.snapshotAccountedBy === authority.snapshotId
      && intent?.generation === authority.generation && intent.eventId === event.eventId
      && event.deferredNativeIntentId === intent.intentId
      && (event.state === 'browser_call_started' || event.state === 'native_event_observed')
      && intent.nativeResult === 'applied_with_evidence'
      && (confirmation?.kind === 'candidate_event' || confirmation?.kind === 'api_return')
      && typeof confirmation.nativeId === 'string' && confirmation.nativeId.length > 0;
  }
  return true;
}

function evidenceNativeId(record: { readonly apiResultEvidence?: JsonObject | null;
  readonly nativeResultConfirmation?: { readonly kind?: string; readonly nativeId?: string } } | undefined): string | undefined {
  const apiId = record?.apiResultEvidence && typeof record.apiResultEvidence.nativeId === 'string'
    ? record.apiResultEvidence.nativeId : undefined;
  if (apiId) return apiId;
  const confirmed = record?.nativeResultConfirmation;
  return confirmed && (confirmed.kind === 'api_return' || confirmed.kind === 'candidate_event')
    && typeof confirmed.nativeId === 'string' ? confirmed.nativeId : undefined;
}

/** Bind a native id that evidence already proved. Never calls Chrome. */
export async function recoverSupersededPullEvent(options: PullApplierOptions, authority: PullApplyAuthority,
  event: UnknownRecord): Promise<void> {
  const effect = (event.payload as { readonly effect?: { readonly kind?: string; readonly node?: PullNode;
    readonly placement?: { readonly parentId?: string }; readonly nodeChildrenRevision?: string | null } })?.effect;
  if (!effect?.node || (effect.kind !== 'node_created' && effect.kind !== 'node_restored')
      || effect.node.kind === 'root' || effect.node.kind === 'alias' || !effect.placement?.parentId) return;
  const intent = typeof event.intentId === 'string' ? authority.intents.get(event.intentId) : undefined;
  const fromEvent = event.apiResultEvidence && typeof event.apiResultEvidence === 'object'
    ? evidenceNativeId({ apiResultEvidence: event.apiResultEvidence as JsonObject }) : undefined;
  const nativeId = evidenceNativeId(intent) ?? fromEvent;
  if (!nativeId) return;
  const existing = await options.store.getMappingByColpId(options.scope, effect.node.id);
  if (existing && !isRecoveryPlaceholder(existing.nativeId)) return;
  const parent = await options.store.getMappingByColpId(options.scope, effect.placement.parentId);
  if (!parent) return;
  try {
    await options.store.putMapping(options.scope, mappingFor(effect.node, nativeId, parent.nativeId, parent.colpId,
      effect.kind === 'node_created' ? effect.nodeChildrenRevision ?? null : null, parent.rootNativeId));
  } catch { /* A mapping constraint must not turn unknown evidence into another create. */ }
}

export async function publishSupersededPullMappings(options: PullApplierOptions, authority: PullApplyAuthority): Promise<void> {
  for (const page of authority.pages) {
    if (!supersededPullPage(authority, page)) continue;
    const pageEvents = await options.store.listPullEventsByPage(options.scope, String(page.pageId));
    for (const event of pageEvents) {
      if (!Array.isArray(event.pendingMappings)) continue;
      for (const stored of event.pendingMappings as Array<MappingInput & { readonly scopeKey?: string }>) {
        if (!stored || typeof stored.colpId !== 'string' || typeof stored.nativeId !== 'string') continue;
        const existing = await options.store.getMappingByColpId(options.scope, stored.colpId);
        if (existing && !isRecoveryPlaceholder(existing.nativeId)) continue;
        const { scopeKey: _scopeKey, ...mapping } = stored;
        try { await options.store.putMapping(options.scope, mapping); } catch { /* evidence remains on the event */ }
      }
    }
  }
}
