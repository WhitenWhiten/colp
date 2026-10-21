import { reportReplicaHealth } from './replica-health.js';
import type { AuthoritativePullEffect, Operation, StrictNode } from '@know-n/colp/types';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import { createBookmarkImportCoordinator } from '../bookmark-import-plan.js';
import { colpCredentialHeaders } from '../auth-client.js';
import { credentialGatedFetch } from '../server-origin-permission.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { createPullApplier } from '../pull-applier.js';
import {
  configureProjectionApplyBarrier, releaseProjectionApplyBarrier, projectionApplyBarrierStatus,
} from '../recovery-projection-executor.js';
import { downloadAuthoritativeEffectPages } from '../effect-page-download.js';
import { inheritEngineFacts } from '../sync-state/engine-transition.js';
import { createSyncStateStore, type SyncScope } from '../sync-state-store.js';
import { bookmarkListenerLifecycle, currentBookmarkEventQueue, recoverBookmarkEvents } from './bookmarks.js';
import { scheduleSyncEngineWake, publicSyncEngineState } from './engine.js';
import { publicImportStatus } from './import.js';
import type { SyncStateEvidenceRequest } from './messages.js';
import { extensionOrigin, faviconSidecar, safeError, store, sw, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope, currentSyncStatusAuthority, loadConfig, pushSessionAuthority } from './scope.js';

export async function handleSyncStateEvidence(message: SyncStateEvidenceRequest) {
  try {
    const [scope, ...args] = message.args as [SyncScope, ...unknown[]];
    const outboundArgs = message.args;
    switch (message.method) {
      case 'registerEvidenceScope': await registerEvidenceScope(scope); return { ok: true, value: null };
      case 'acquireEvidenceLease': return { ok: true, value: await isolatedEvidenceStore((isolated) =>
        isolated.acquireLease(scope, String(args[0]), Number(args[1] ?? 1_000), 30_000)) };
      case 'enqueueEvidence': return { ok: true, value: await isolatedEvidenceStore((isolated) =>
        enqueueEvidence(scope, String(args[0]), isolated)) };
      case 'claimEvidenceQueue': return { ok: true, value: await isolatedEvidenceStore((isolated) =>
        isolated.claimQueue(scope, String(args[0]), Number(args[1]), Number(args[2]), 1)) };
      case 'completeEvidenceQueue': return { ok: true, value: await isolatedEvidenceStore((isolated) =>
        isolated.completeClaimedQueueWithReceipt(scope, Number(args[0]), String(args[1]), Number(args[2]), {
          opId: String(args[3]), operationDigest: String(args[4]), kind: 'terminal', receiptId: 'receipt-fenced',
          resultDigest: 'sha256:fenced-result',
        })) };
      case 'exportScope': return { ok: true, value: await syncState.exportScope(scope) };
      case 'exportAuthorityIdentity': {
        // The session record lives in `chrome.storage.session`, pinned to
        // TRUSTED_CONTEXTS, so an extension PAGE cannot read it — which is the
        // point of the split. E2e helpers that must act as the peer device therefore
        // ask the worker for the identity fields they need instead of reading
        // storage directly. Identity only: the bearer is NOT returned, so this does
        // not widen the exposure even in a dev build — a caller gets the token the
        // way production does, from the browser's cookie jar.
        const session = await store.loadSession();
        if (session === null) return { ok: true, value: null };
        const binding = await store.loadBinding();
        return { ok: true, value: {
          sessionId: session.sessionId,
          collectionId: session.collection.collectionId,
          replicaId: binding?.replicaId ?? null,
        } };
      }
      case 'exportArchive': return { ok: true, value: await syncState.exportArchive(scope) };
      case 'exportLegacyDiagnostic': return { ok: true, value: await syncState.exportLegacyDiagnostic() };
      case 'seedEvidence': return { ok: true, value: await seedEvidence(scope) };
      case 'configureEventEvidence': return { ok: true, value: await configureEventEvidence(scope, String(args[0]),
        args[1] === null ? null : String(args[1]), args[2] === undefined ? undefined : String(args[2]) as typeof sw.eventEvidenceFault) };
      case 'configureCaptureFaultEvidence': {
        const fault = outboundArgs[0];
        sw.eventEvidenceFault = fault === 'before_stage' || fault === 'after_sequence'
          || fault === 'after_queue' || fault === 'after_event' ? fault : undefined;
        sw.bookmarkEventQueue = undefined; sw.bookmarkEventScopeKey = undefined;
        return { ok: true, value: null };
      }
      case 'configureProjectionApplyBarrierEvidence':
        // Second argument selects `hold`: the apply suspends at the barrier with
        // the bookmark created and the mapping not yet durable, so a test can
        // interrupt a genuinely mid-flight write.
        configureProjectionApplyBarrier(outboundArgs[0] === 'after_chrome_create_before_mapping'
          ? 'after_chrome_create_before_mapping' : undefined,
        outboundArgs[1] === 'hold' ? 'hold' : 'throw');
        return { ok: true, value: null };
      case 'releaseProjectionApplyBarrierEvidence':
        return { ok: true, value: releaseProjectionApplyBarrier() };
      case 'projectionApplyBarrierStatus':
        return { ok: true, value: projectionApplyBarrierStatus() };
      case 'dropNativeMappingEvidence': {
        const nativeId = String(outboundArgs[0] ?? '');
        return { ok: true, value: nativeId ? await syncState.deleteMapping(await currentSyncScope(), nativeId) : false };
      }
      case 'configureOutboundBookmarkRoot': return { ok: true, value: await configureOutboundBookmarkRoot(
        await currentSyncScope(), String(outboundArgs[0]), outboundArgs[1] === null ? null : String(outboundArgs[1]),
        String(outboundArgs[2]), String(outboundArgs[3])) };
      case 'configureOutboundPushFaultEvidence': sw.outboundPushFaultEvidence = outboundArgs[0] === 'after_receipt'
        ? 'after_receipt' : undefined; return { ok: true, value: null };
      case 'configureOutboundLeaseEvidence': { const duration = Number(outboundArgs[0]);
        if (!Number.isSafeInteger(duration) || duration < 1) throw new Error('lease_duration_invalid');
        sw.outboundLeaseDurationEvidence = duration; return { ok: true, value: null }; }
      case 'configureOutboundBoundaryEvidence': sw.outboundBoundaryEvidence = outboundArgs[0] === 'before_attempt_persist'
        || outboundArgs[0] === 'after_attempt_persist' ? outboundArgs[0] : undefined; return { ok: true, value: null };
      case 'configureOutboundCanonicalFixture': return { ok: true, value: await configureOutboundCanonicalFixture(
        await currentSyncScope(), String(outboundArgs[0]), outboundArgs[1] === null ? null : String(outboundArgs[1]),
        String(outboundArgs[2]), String(outboundArgs[3]), outboundArgs[4]) };
      case 'drainBookmarkEventCaptureEvidence':
        await bookmarkListenerLifecycle.settled();
        await workCoordinator.run('bookmark', async () => undefined);
        await (await currentBookmarkEventQueue())?.flush();
        return { ok: true, value: null };
      case 'recoverBookmarkEventEvidence': sw.eventEvidenceScope = scope; sw.eventEvidenceFault = undefined;
        sw.bookmarkEventQueue = undefined; sw.bookmarkEventScopeKey = undefined; await recoverBookmarkEvents();
        return { ok: true, value: null };
      case 'confirmBookmarkEventEvidence': return { ok: true, value: await confirmBookmarkEventEvidence(scope,
        String(args[0]), String(args[1]), args[2] === undefined ? undefined : String(args[2])) };
      case 'seedOutboundPushEvidence': return { ok: true, value: await seedOutboundPushEvidence() };
      case 'wakeOutboundPushEvidence': await scheduleSyncEngineWake('manual'); return { ok: true, value: null };
      case 'duplicateAlarm': scheduleSyncEngineWake('alarm'); await scheduleSyncEngineWake('alarm');
        return { ok: true, value: null };
      case 'configureDurableEngineEvidence': return { ok: true,
        value: await configureDurableEngineEvidence(String(outboundArgs[0])) };
      case 'reportReplicaHealthEvidence': await reportReplicaHealth(true); return { ok: true, value: null };
      case 'wakeDurableEngineEvidence': await scheduleSyncEngineWake('manual'); return { ok: true, value: null };
      case 'syncEngineState': { const authority = await currentSyncStatusAuthority();
        return { ok: true, value: await publicSyncEngineState(authority.scope, authority.credential,
          authority.session, authority.config) }; }
      case 'exportOutboundPushEvidence': return { ok: true, value: await syncState.exportScope(await currentSyncScope()) };
      case 'exportFaviconSidecarEvidence': { const evidenceScope = await currentSyncScope();
        return { ok: true, value: await faviconSidecar.list(evidenceScope.collectionId) }; }
      case 'bookmarkImportStatus': { const importScope = await currentSyncScope(); return { ok: true,
        value: publicImportStatus(await createBookmarkImportCoordinator({ store: syncState, scope: importScope }).status()) }; }
      case 'exportPullApplyEvidence': return { ok: true, value: await syncState.exportScope(await currentSyncScope()) };
      case 'pullNowEvidence': { const scope = await currentSyncScope(); const authority = await pushSessionAuthority();
        const endpoints = await fetchSyncEndpoints(await loadConfig()); const current = await syncState.getScope(scope);
        if (!current?.checkpoint) throw new Error('pull_cursor_missing');
        await createPullApplier({ scope, store: syncState, session: { acceptedProtocolVersion:
          authority.session.acceptedProtocolVersion, sessionId: authority.session.sessionId,
          collectionId: authority.session.collection.collectionId, conversionPolicy: authority.session.conversionPolicy,
          transportBudget: authority.session.transportBudget },
          endpoints, effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: endpoints.effectPageAuthority,
          credential: authority.credential, origin: extensionOrigin(), fetch: credentialGatedFetch(fetch) }).pull(current.checkpoint.cursor);
        return { ok: true, value: await syncState.exportScope(scope) }; }
      case 'downloadEffectPagesEvidence': {
        const effectScope = await currentSyncScope(); const authority = await pushSessionAuthority();
        const endpoints = await fetchSyncEndpoints(await loadConfig());
        const effectId = String(outboundArgs[0]); const pageCount = Number(outboundArgs[1]);
        const memberCount = Number(outboundArgs[2]);
        try {
          const pages = await downloadAuthoritativeEffectPages({
            scope: effectScope, store: syncState,
            refs: [{ effectId, pageCount, memberCount }],
            template: endpoints.syncEffectPages, authority: endpoints.effectPageAuthority,
            headers: { Accept: 'application/json', ...colpCredentialHeaders(authority.credential.accessToken),
              Origin: extensionOrigin(), 'Known-Sync-Session': authority.session.sessionId,
              'Collection-Protocol-Version': '0.2' },
            remainingBytes: 2 * 1024 * 1024, fetch: credentialGatedFetch(fetch), now: Date.now,
          });
          return { ok: true, value: { status: 'complete', pageCount: pages.length,
            memberCount: pages.reduce<number>((total, page) => total + effectPageMemberCount(page), 0),
            download: await syncState.getEffectDownload(effectScope, effectId) } };
        } catch (error) {
          return { ok: true, value: { status: safeError(error),
            download: await syncState.getEffectDownload(effectScope, effectId) } };
        }
      }
      case 'stagePullCreateEvidence': { const evidenceScope = scope; const nativeParentId = String(args[0]);
        const parent = await syncState.getMappingByNativeId(evidenceScope, nativeParentId);
        if (!parent) throw new Error('event_evidence_root_mapping_missing');
        const applier = createPullApplier({ scope: evidenceScope, store: syncState,
          session: { acceptedProtocolVersion: '0.2', sessionId: 'evidence-session', collectionId: evidenceScope.collectionId,
            conversionPolicy: { separator: 'preserve_remote' } },
          effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
          effectPageAuthority: 'https://known.example', fetch: credentialGatedFetch(fetch) });
        await applier.stage(pullCreateEvidencePage(evidenceScope.collectionId, parent.colpId)); await applier.resume();
        await workCoordinator.run('bookmark', async () => undefined); return { ok: true, value: await syncState.exportScope(evidenceScope) }; }
      case 'stagePullCreateCrashEvidence': { const evidenceScope = scope; const nativeParentId = String(args[0]);
        const parent = await syncState.getMappingByNativeId(evidenceScope, nativeParentId);
        if (!parent) throw new Error('event_evidence_root_mapping_missing');
        const applier = evidencePullApplier(evidenceScope, () => { throw new Error('worker_crash'); });
        await applier.stage(pullCreateEvidencePage(evidenceScope.collectionId, parent.colpId));
        try { await applier.resume(); } catch (error) {
          if (!(error instanceof Error) || error.message !== 'worker_crash') throw error;
        }
        return { ok: true, value: await syncState.exportScope(evidenceScope) }; }
      case 'resumePullApplyEvidence': { const evidenceScope = scope; await evidencePullApplier(evidenceScope).resume();
        await workCoordinator.run('bookmark', async () => undefined); return { ok: true, value: await syncState.exportScope(evidenceScope) }; }
      default: throw new Error('evidence_method_invalid');
    }
  } catch (error) { return { ok: false, error: safeError(error) }; }
}

function effectPageMemberCount(page: unknown): number {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return 0;
  const members = (page as Record<string, unknown>).members;
  return Array.isArray(members) ? members.length : 0;
}

async function isolatedEvidenceStore<T>(work: (isolated: ReturnType<typeof createSyncStateStore>) => Promise<T>) {
  const isolated = createSyncStateStore();
  try { return await work(isolated); } finally { isolated.close(); }
}

function pullCreateEvidencePage(collectionId: string, parentId: string) {
  const operation = { opId: 'op-pull-evidence', replicaId: 'replica-pull-source', sequence: 1, collectionId,
    type: 'create_node', baseRevision: null, occurredAt: '2026-07-28T00:00:00.000Z', dependencies: [],
    payload: { parentId, node: { kind: 'bookmark', title: 'Remote', url: 'https://example.test/' } } } satisfies Operation;
  const node = { id: 'node-pull-evidence', collectionId, kind: 'bookmark', parentId, position: 'p1', visibility: 'private',
    revision: 'revision-pull-evidence', createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z', title: 'Remote', url: 'https://example.test/' } satisfies StrictNode;
  const effectInput = { effectId: operation.opId, status: 'applied', opId: operation.opId,
    replicaId: operation.replicaId, sequence: operation.sequence, collectionId,
    operationDigest: canonicalOperationDigest(operation), effectDigest: '', kind: 'node_created', node,
    placement: { parentId, afterId: null, beforeId: null, position: 'p1' },
    parentRevision: { parentId, childrenRevision: 'children-pull-evidence' }, nodeChildrenRevision: null
  } satisfies AuthoritativePullEffect;
  const effect = { ...effectInput,
    effectDigest: canonicalAuthoritativeEffectDigest(effectInput as unknown as Record<string, unknown>) };
  return { events: [{ cursor: 'cursor-pull-evidence', kind: 'operation', operation, effect }],
    nextCursor: 'cursor-pull-evidence', hasMore: false, collectionRevision: 'revision-pull-evidence',
    recommendedPullAfterSeconds: 0 };
}

function evidencePullApplier(scope: SyncScope, crash?: (boundary: string) => void) {
  return createPullApplier({ scope, store: syncState,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'evidence-session', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', fetch: credentialGatedFetch(fetch), ...(crash ? { crash: (boundary: string) => {
      // The evidence fixture interrupts the create after its Chrome call started, which is the
      // state `stagePullCreateCrashEvidence` asserts (`browser_call_started`). The runtime records
      // that state in `persistStarted`, immediately before `input.create()`
      // (`native-create-executor.ts`), so the `before_event` boundary at the top of
      // `callAndCommit` fires too early and leaves the event at `intent_prepared`.
      //
      // The boundary is deliberately *after* the receipt rather than immediately after the Chrome
      // call: an interrupt with no recorded native id leaves `native_result_unknown`, which parks
      // the event for user confirmation (the SR-01 exit) instead of resuming automatically. The
      // fixture's later phase asserts a clean automatic resume, so it supplies the receipt the
      // real worker persists before the crash it models.
      if (boundary === 'after_evidence_before_mapping') crash(boundary); } } : {}) });
}

async function configureEventEvidence(scope: SyncScope, selectedNativeId: string, privateNativeId: string | null,
  fault?: typeof sw.eventEvidenceFault) {
  const existing = await syncState.getScope(scope);
  if (!existing) await syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-event-evidence', expiresAt: Number.MAX_SAFE_INTEGER },
    checkpoint: { serverRevision: 'event-evidence-revision', cursor: 'event-evidence-cursor' },
    selectedRoots: [], rootStatus: 'ready' });
  await syncState.configureBrowserRoots(scope, { discovered: [
    { nativeId: selectedNativeId, ancestorNativeIds: [] },
    ...(privateNativeId ? [{ nativeId: privateNativeId, ancestorNativeIds: [] }] : []),
  ], selectedNativeIds: [selectedNativeId], privateNativeIds: privateNativeId ? [privateNativeId] : [], status: 'ready' });
  const selected = await syncState.getMappingByNativeId(scope, selectedNativeId);
  if (!selected) throw new Error('event_evidence_root_mapping_missing');
  // Crash-point recovery flushes a pending create against trustedIdentity: a
  // pending-/local- root id would skip commit and leave an empty queue.
  // putMapping cannot change colpId in place (identity constraint).
  await syncState.deleteMapping(scope, selected.nativeId);
  await syncState.putMapping(scope, { nativeId: selected.nativeId, colpId: 'event-evidence-root',
    rootNativeId: selected.nativeId, nodeKind: 'folder',
    projection: { revision: 'event-evidence-root-revision', childrenRevision: 'event-evidence-root-revision',
      digest: 'sha256:event-evidence-root' } });
  await configureEvidenceMount(scope, selectedNativeId, 'event-evidence-root');
  sw.eventEvidenceScope = scope; sw.eventEvidenceFault = fault; sw.bookmarkEventQueue = undefined; sw.bookmarkEventScopeKey = undefined;
}

async function configureOutboundBookmarkRoot(scope: SyncScope, selectedNativeId: string, privateNativeId: string | null,
  canonicalRootId: string, canonicalRevision: string) {
  const existing = await syncState.getScope(scope);
  if (!existing) await syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-outbound-evidence', expiresAt: Number.MAX_SAFE_INTEGER },
    checkpoint: { serverRevision: canonicalRevision, cursor: 'outbound-evidence-cursor' },
    selectedRoots: [], rootStatus: 'ready' });
  await syncState.putMapping(scope, { nativeId: selectedNativeId, colpId: canonicalRootId,
    rootNativeId: selectedNativeId, nodeKind: 'folder',
    projection: { revision: canonicalRevision, childrenRevision: canonicalRevision,
      digest: 'sha256:outbound-canonical-root' } });
  await syncState.configureBrowserRoots(scope, { discovered: [
    { nativeId: selectedNativeId, ancestorNativeIds: [] },
    ...(privateNativeId ? [{ nativeId: privateNativeId, ancestorNativeIds: [] }] : []),
  ], selectedNativeIds: [selectedNativeId], privateNativeIds: privateNativeId ? [privateNativeId] : [], status: 'ready' });
  await configureEvidenceMount(scope, selectedNativeId, canonicalRootId);
  await prepareEvidenceEngine(scope);
}

async function configureOutboundCanonicalFixture(scope: SyncScope, selectedNativeId: string, privateNativeId: string | null,
  folderNativeId: string, bookmarkNativeId: string, rawFixture: unknown) {
  if (!rawFixture || typeof rawFixture !== 'object' || Array.isArray(rawFixture)) throw new Error('canonical_fixture_invalid');
  const fixture = rawFixture as Record<string, unknown>;
  const value = (name: string) => { const item = fixture[name];
    if (typeof item !== 'string' || !item) throw new Error('canonical_fixture_invalid'); return item; };
  const rootId = value('rootId'); const rootRevision = value('rootRevision');
  const folderId = value('folderId'); const folderRevision = value('folderRevision');
  const bookmarkId = value('bookmarkId'); const bookmarkRevision = value('bookmarkRevision');
  const folderTitle = value('folderTitle'); const bookmarkTitle = value('bookmarkTitle'); const bookmarkUrl = value('bookmarkUrl');
  await syncState.putMapping(scope, { nativeId: selectedNativeId, colpId: rootId, rootNativeId: selectedNativeId,
    nodeKind: 'folder', projection: { revision: typeof fixture.rootResourceRevision === 'string' ? fixture.rootResourceRevision : rootRevision, childrenRevision: rootRevision,
      digest: 'sha256:canonical-root' } });
  await syncState.putMapping(scope, { nativeId: folderNativeId, colpId: folderId, rootNativeId: selectedNativeId,
    nodeKind: 'folder', parentNativeId: selectedNativeId, projection: { revision: typeof fixture.folderResourceRevision === 'string' ? fixture.folderResourceRevision : folderRevision,
      childrenRevision: folderRevision, digest: 'sha256:canonical-folder', content: { title: folderTitle } } });
  await syncState.putMapping(scope, { nativeId: bookmarkNativeId, colpId: bookmarkId, rootNativeId: selectedNativeId,
    nodeKind: 'bookmark', parentNativeId: fixture.bookmarkParentId === folderId ? folderNativeId : selectedNativeId,
    parentColpId: fixture.bookmarkParentId === folderId ? folderId : rootId, projection: { revision: bookmarkRevision,
      digest: 'sha256:canonical-bookmark', content: { title: bookmarkTitle, url: bookmarkUrl } } });
  await syncState.configureBrowserRoots(scope, { discovered: [
    { nativeId: selectedNativeId, ancestorNativeIds: [] },
    ...(privateNativeId ? [{ nativeId: privateNativeId, ancestorNativeIds: [] }] : []),
  ], selectedNativeIds: [selectedNativeId], privateNativeIds: privateNativeId ? [privateNativeId] : [], status: 'ready' });
  await configureEvidenceMount(scope, selectedNativeId, rootId);
  await prepareEvidenceEngine(scope);
}

async function configureEvidenceMount(scope: SyncScope, nativeId: string, colpId: string) {
  // Real Chrome ingress and Pull require a mounted selection, not just legacy roots.
  await syncState.putMountBinding(scope, { mountId: `event-evidence:${nativeId}`,
    nativeRootId: nativeId, remoteMountNodeId: colpId, boundaryVersion: '1',
    materialized: false, status: 'active', customSourceKey: `event-evidence:${nativeId}` });
}

async function prepareEvidenceEngine(scope: SyncScope) {
  sw.eventEvidenceScope = scope;
  sw.eventEvidenceFault = undefined;
  sw.bookmarkEventQueue = undefined;
  sw.bookmarkEventScopeKey = undefined;
  await workCoordinator.run('engine', async () => undefined);
  scheduleSyncEngineWake('manual');
  await workCoordinator.run('engine', async () => undefined);
}

export async function unfreezeEvidenceEngineForSeed(scope: SyncScope) {
  const state = await syncState.getEngineState(scope);
  if (!state?.recoveryFrozen) return;
  // SR-06: keep this seed-only unfreeze on the same CAS + field-inheritance contract as
  // `freezeScopeRecovery` and the bootstrap-Ack reject, so a third direct write cannot
  // drift back into silently dropping the prior cursor/connectivity facts.
  await syncState.transitionEngine(scope, { phase: 'idle', updatedAt: Date.now(), recoveryFrozen: false,
    authorityRefreshRequired: false, notBefore: 0, ...inheritEngineFacts(state),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}), expectedRevision: state.revision });
}

async function confirmBookmarkEventEvidence(scope: SyncScope, nativeId: string, revision: string,
  confirmedColpId?: string) {
  const mapping = await syncState.getMappingByNativeId(scope, nativeId);
  if (!mapping) throw new Error('event_evidence_mapping_missing');
  const queued = (await syncState.listQueue(scope)).findLast(row => row.status !== 'terminal'
    && (mapping.colpId === `pending-${row.opId}` || row.operationRevision === mapping.projection.revision));
  if (queued) {
    const targetId = mapping.colpId.startsWith('pending-') ? confirmedColpId ?? `confirmed-${queued.opId}` : mapping.colpId;
    await syncState.completeQueueWithReceipt(scope, queued.sequence, {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `evidence:${queued.opId}`,
      resultDigest: queued.digest, result: { results: [{ opId: queued.opId, sequence: queued.sequence,
        status: 'applied', targetId, revision }] },
    });
  }
  if (mapping.colpId.startsWith('pending-')) {
    const opId = mapping.colpId.slice('pending-'.length);
    await syncState.rebindProvisionalBookmarkIdentity(scope, nativeId, opId,
      confirmedColpId ?? `confirmed-${opId}`, revision);
  } else {
    await syncState.putMapping(scope, { nativeId: mapping.nativeId, colpId: mapping.colpId,
      rootNativeId: mapping.rootNativeId, ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
      ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
      projection: { revision, digest: mapping.projection.digest,
        ...(mapping.projection.content ? { content: mapping.projection.content } : {}) } });
  }
  // A real server confirmation is observed through the Pull echo, which also
  // carries a folder's children revision; mirror that here so a confirmed
  // folder accepts subsequent move targets instead of filtering them.
  const confirmed = await syncState.getMappingByNativeId(scope, nativeId);
  if (confirmed && confirmed.nodeKind === 'folder' && !confirmed.projection.childrenRevision) {
    await syncState.putMapping(scope, { nativeId: confirmed.nativeId, colpId: confirmed.colpId,
      rootNativeId: confirmed.rootNativeId, nodeKind: confirmed.nodeKind,
      ...(confirmed.parentNativeId ? { parentNativeId: confirmed.parentNativeId } : {}),
      projection: { revision: confirmed.projection.revision, childrenRevision: revision,
        digest: confirmed.projection.digest,
        ...(confirmed.projection.content ? { content: confirmed.projection.content } : {}) } });
  }
  await (await currentBookmarkEventQueue())?.flush();
}

async function registerEvidenceScope(scope: SyncScope) {
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-evidence', expiresAt: 60_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: ['root-evidence'] });
}

async function enqueueEvidence(scope: SyncScope, opId: string, target = syncState) {
  return target.allocateSequenceAndEnqueue(scope, { opId, batchId: `batch:${opId}`,
    idempotencyKey: `idempotency:${opId}`, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'revision-0',
    operationRevision: 'revision-local-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'update_node', targetId: 'node-evidence' } }, { allowUnstamped: true });
}

async function seedEvidence(scope: SyncScope) {
  await registerEvidenceScope(scope);
  await syncState.putMapping(scope, { nativeId: 'native-evidence', colpId: 'node-evidence', rootNativeId: 'root-evidence',
    projection: { revision: 'revision-0', digest: 'sha256:projection-0' } });
  const queued = await enqueueEvidence(scope, 'op-evidence');
  await syncState.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId, operationDigest: queued.digest,
    kind: 'terminal', receiptId: 'receipt-evidence', resultDigest: 'sha256:result-evidence' });
  await syncState.publishCursor(scope, { cursor: 'cursor-evidence', checkpoint: 'checkpoint-evidence',
    evidence: { receiptId: 'receipt-evidence', operationDigest: queued.digest } });
  await syncState.createApplyIntent(scope, { intentId: 'intent-evidence', correlationId: 'correlation-evidence',
    operationId: 'remote-evidence', expected: { kind: 'change', nativeId: 'native-evidence' },
    nativeResult: 'unknown', expiresAt: 60_000 });
  await syncState.stageRecoveryPage(scope, { snapshotId: 'snapshot-evidence', revision: 'revision-recovery',
    syncCursor: 'cursor-evidence', capability: 'bookmarks-v1', identityDigest: 'identity-evidence',
    rootNodeId: 'node-recovery',
    page: 0, pageDigest: 'sha256:page-evidence', previousPageDigest: null,
    nextCursor: null, complete: true, nodes: [{ colpId: 'node-recovery', parentId: null, position: 'a',
      kind: 'Folder', payloadDigest: 'sha256:node-recovery' }] });
  return syncState.exportScope(scope);
}

async function configureDurableEngineEvidence(nativeRootId: string) {
  const scope = await currentSyncScope(); const canonical = await syncState.getMappingByColpId(scope, 'p3-27-root');
  const selectedNativeId = canonical?.nativeId ?? nativeRootId;
  const mapping = await syncState.getMappingByNativeId(scope, selectedNativeId);
  if (!mapping) await syncState.putMapping(scope, { nativeId: selectedNativeId, colpId: 'p3-27-root', rootNativeId: selectedNativeId,
    nodeKind: 'folder', projection: { revision: 'r1', childrenRevision: 'r1', digest: 'snapshot:evidence-root' } });
  await syncState.configureBrowserRoots(scope, { discovered: [{ nativeId: selectedNativeId, ancestorNativeIds: [] }],
    selectedNativeIds: [selectedNativeId], privateNativeIds: [], status: 'ready' });
  await configureEvidenceMount(scope, selectedNativeId, 'p3-27-root');
  await prepareEvidenceEngine(scope);
  return selectedNativeId;
}

async function seedOutboundPushEvidence() {
  const scope = await currentSyncScope(); const prior = await syncState.listQueue(scope, 'pending', 0, 1);
  if (prior.length) return prior[0];
  if ((await syncState.getEngineState(scope))?.recoveryFrozen) await unfreezeEvidenceEngineForSeed(scope);
  const opId = crypto.randomUUID();
  const operation = { opId, replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
    type: 'create_node', baseRevision: null, occurredAt: new Date().toISOString(), dependencies: [],
    payload: { parentId: 'p3-27-root', node: { kind: 'bookmark', title: 'P3-31 public',
      url: 'https://example.test/p3-31' } } };
  await syncState.putMapping(scope, { nativeId: 'native-p3-31-create', colpId: `pending-${opId}`,
    rootNativeId: 'root-p3-31', nodeKind: 'bookmark', parentNativeId: 'root-p3-31',
    projection: { revision: `local-${opId}`, digest: `sha256:${opId}`,
      content: { title: 'P3-31 public', url: 'https://example.test/p3-31' } } });
  const queued = await syncState.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
    digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: operation }, { allowUnstamped: true });
  const database = await syncState.open(); const scopeKey = (await syncState.getScope(scope))!.scopeKey;
  const transaction = database.transaction('bookmark_events', 'readwrite');
  transaction.objectStore('bookmark_events').add({ scopeKey, eventId: `event-${opId}`, ordinal: 1,
    dedupeKey: `dedupe-${opId}`, occurredAt: operation.occurredAt, kind: 'create',
    nativeId: 'native-p3-31-create', details: { draft: { type: 'create_node' } }, status: 'processed', opId });
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
  return queued;
}
