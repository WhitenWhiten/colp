import { remoteDeleteDeferral } from '../remote-delete-pending-facts.js';
import { issueProtectionIds } from '../sync-issues.js';
import { transactionIssueDependencies, ISSUE_DEPENDENCY_STORES } from './issue-dependencies.js';
import { putPullIssueFact } from './pull-issue-repository.js';
import { addQueueIssueRoots, blockedPullIssue } from './open-issue-facts.js';
import { extractOutstandingTarget } from '../recovery-overlay.js';
import { markQueuePullEchoApplied } from './pull-queue-echo.js';
import {
  SyncStateError, type AckIntentRecord, type DurableSyncEngineState, type IntentRecord, type MappingInput,
  type QueueOperation, type RecoveryHeader, type RecoveryNodeRecord, type RecoveryPageInput, type BookmarkEventRecord,
  type SyncScope, type UnknownRecord,
} from './types.js';
import { boundedString, clone } from './codec.js';
import { cursorPage, deleteByIndexRange, deleteScopeRows, iterateCursor, requestValue, requireActiveScope,
  runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateMapping, validateMappingRecord } from './mapping-repository.js';
import { sameAckIntent } from './engine-validate.js';
import { cursorIsConfirmed } from './cursor-confirmation.js';
import { validateAckIntent, validateRecoveryPage, samePullEventRecord } from './pull-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

/**
 * F005/B1 growth-page handover. The server re-paged the unacked stretch from the same
 * chain head under a new pageId (pageId changes, the leading eventId does not), so the
 * blocked page sitting on that head can neither replay (its bytes differ) nor complete.
 * Adopt its events into the incoming page - keeping every event's apply state, so an
 * already-applied event is never applied to Chrome twice - re-home the effect pages and
 * drop the blocked page with a durable diagnostic. A blocked event the incoming page
 * does not re-deliver byte-for-byte is a protocol conflict, not a handover: reject it
 * with the named `pull_event_conflict` (frozen) instead of letting the raw IndexedDB
 * ConstraintError loop under an `active` lifecycle.
 */
export async function adoptBlockedPagesAtChainHead(tx: IDBTransaction, key: string,
  page: { readonly pageId: string; readonly previousCursor: string; readonly events: readonly UnknownRecord[] }): Promise<void> {
  const pages = tx.objectStore(STORES.pullPages);
  const stale = (await cursorPage<UnknownRecord>(pages, scopeRowsRange(key), Number.MAX_SAFE_INTEGER))
    .filter((row) => String(row.state) === 'blocked' && row.previousCursor === page.previousCursor);
  if (stale.length === 0) return;
  const events = tx.objectStore(STORES.pullEvents); const effectPages = tx.objectStore(STORES.effectPages);
  const wanted = new Map(page.events.map((event, ordinal) => [String(event.eventId), { event, ordinal }]));
  for (const row of stale) {
    const own = (await cursorPage<UnknownRecord>(events, scopeRowsRange(key), Number.MAX_SAFE_INTEGER))
      .filter((event) => event.pageId === row.pageId);
    for (const event of own) {
      const match = wanted.get(String(event.eventId));
      if (!match || !samePullEventRecord(event, match.event)) throw new SyncStateError('pull_event_conflict');
      events.put({ ...event, pageId: page.pageId, ordinal: match.ordinal });
    }
    await iterateCursor(effectPages, scopeRowsRange(key), (value) => {
      const effectPage = value as UnknownRecord; if (effectPage.pageId !== row.pageId) return;
      if (!wanted.has(String(effectPage.eventId))) throw new SyncStateError('pull_event_conflict');
      effectPages.put({ ...effectPage, pageId: page.pageId });
    });
    pages.delete([key, String(row.pageId)]);
    tx.objectStore(STORES.diagnostics).put({ id: `pull-page-handover:${key}:${row.pageId}`, scopeKey: key,
      kind: 'pull_page_handover', code: 'superseded_by_growth_page', pageId: String(row.pageId),
      recoveryCode: row.recoveryCode ?? null, previousCursor: row.previousCursor, nextCursor: row.nextCursor,
      authorityCursor: page.previousCursor, newPageId: page.pageId, at: Date.now() });
  }
}

/**
 * Pages still on the authority cursor. Completed history is not a live chain.
 * `accepts` rejects a page whose authority generation does not match.
 */
export function pullPagesOnAuthorityChain(pages: readonly UnknownRecord[], authorityCursor: string,
  accepts: (page: UnknownRecord) => boolean = () => true): Set<string> {
  const byPrevious = new Map<string, UnknownRecord[]>();
  for (const page of pages) {
    if (String(page.state) === 'page_complete' || !accepts(page)) continue;
    const list = byPrevious.get(String(page.previousCursor)) ?? [];
    list.push(page); byPrevious.set(String(page.previousCursor), list);
  }
  const attached = new Set<string>(); const pending = [authorityCursor]; const seen = new Set<string>();
  while (pending.length > 0) {
    const head = pending.pop()!; if (seen.has(head)) continue; seen.add(head);
    for (const page of byPrevious.get(head) ?? []) {
      const pageId = String(page.pageId); if (attached.has(pageId)) continue;
      attached.add(pageId); pending.push(String(page.nextCursor));
    }
  }
  return attached;
}

export function pullPageAuthorityStamps(records: readonly UnknownRecord[]): Map<string, {
  readonly authorityGeneration?: number; readonly leaseGeneration?: string;
}> {
  const stamps = new Map<string, { authorityGeneration?: number; leaseGeneration?: string }>();
  for (const row of records) {
    if (row.kind !== 'pull_page_authority' || !row.details || typeof row.details !== 'object') continue;
    const details = row.details as UnknownRecord;
    const pageId = typeof details.pageId === 'string' ? details.pageId : typeof row.code === 'string' ? row.code : '';
    if (!pageId) continue;
    stamps.set(pageId, {
      ...(typeof details.authorityGeneration === 'number' ? { authorityGeneration: details.authorityGeneration } : {}),
      ...(typeof details.leaseGeneration === 'string' ? { leaseGeneration: details.leaseGeneration } : {}),
    });
  }
  return stamps;
}

/**
 * `staged` plus a proved not-started intent is not-called. Prepared, browser_call_started,
 * and every other unproven result stay unknown. Committed events are known unless the
 * intent still says the native result cannot be proved.
 */
export function pullEventCallFact(event: UnknownRecord, intent: IntentRecord | undefined): 'not_called' | 'unknown' | 'known' {
  const state = String(event.state);
  const provedNotCalled = !intent || (intent.nativeResult === 'not_started'
    && (intent.replayState === undefined || intent.replayState === 'not_started')
    && intent.state !== 'intent_prepared' && intent.state !== 'browser_call_started'
    && intent.state !== 'native_event_observed' && intent.state !== 'awaiting_confirmation');
  if (state === 'staged' && provedNotCalled) return 'not_called';
  if (state === 'authority_committed' || state === 'page_complete') {
    if (!intent || (intent.nativeResult !== 'result_unknown' && intent.nativeResult !== 'unknown'
        && intent.replayState !== 'unknown'
        && !((intent.replayState === 'started' || intent.replayState === 'awaiting_receipt')
          && intent.nativeResult !== 'applied_with_evidence' && intent.nativeResult !== 'absent'
          && intent.nativeResult !== 'failed'))) return 'known';
  }
  return 'unknown';
}

export function createRecoveryRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function hasRecoveryStaging(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.recovery, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.recovery), scopeRowsRange(key), 1);
    await completion; return rows.length > 0;
  }

  /**
   * Rebase handover. Live pages are those whose previousCursor chain reaches `cursor`
   * and whose authority generation matches. Not-called staged events are retired
   * with their effect pages, pull acks, and queue echoes. Prepared, browser_call_started,
   * and any other unknown native result are parked, not deleted and not applied.
   * Known-applied blocked pages keep the narrow discard. This is not commitRecovery's wipe.
   */
  async function handOverSupersededPullAuthority(tx: IDBTransaction, key: string, cursor: string,
    scope: { readonly generation: number; readonly lease?: { readonly generation?: string } }): Promise<void> {
    const pageStore = tx.objectStore(STORES.pullPages);
    const pages = await cursorPage<UnknownRecord>(pageStore, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    const events = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    const effectPages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.effectPages), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    const intents = await cursorPage<IntentRecord>(tx.objectStore(STORES.intents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    const acks = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    const diagnosticRows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
      IDBKeyRange.bound([key, ''], [key, '\uffff']), Number.MAX_SAFE_INTEGER);
    const stamps = pullPageAuthorityStamps(diagnosticRows);
    const intentById = new Map(intents.map((intent) => [intent.intentId, intent]));
    const intentFor = (event: UnknownRecord) => (typeof event.intentId === 'string' ? intentById.get(event.intentId) : undefined)
      ?? intents.find((intent) => intent.eventId === event.eventId);
    const eventsOf = (pageId: string) => events.filter((event) => event.pageId === pageId);
    const matches = (page: UnknownRecord) => {
      const stamp = stamps.get(String(page.pageId));
      if (stamp?.authorityGeneration !== undefined && stamp.authorityGeneration !== scope.generation) return false;
      if (stamp?.leaseGeneration !== undefined && stamp.leaseGeneration !== scope.lease?.generation) return false;
      return eventsOf(String(page.pageId)).every((event) => {
        const intent = intentFor(event);
        return !(intent && typeof intent.generation === 'number' && intent.generation !== scope.generation);
      });
    };
    const attached = pullPagesOnAuthorityChain(pages, cursor, matches);
    const eventStore = tx.objectStore(STORES.pullEvents); const effectStore = tx.objectStore(STORES.effectPages);
    const intentStore = tx.objectStore(STORES.intents); const ackStore = tx.objectStore(STORES.ackIntents);
    const diagnosticStore = tx.objectStore(STORES.diagnostics);
    const retiredOps = new Set<string>(); let discardedBlocked = false;
    const dropEvent = (event: UnknownRecord) => {
      eventStore.delete([key, String(event.eventId)]);
      if (typeof event.operationId === 'string') retiredOps.add(event.operationId);
      const intent = intentFor(event);
      if (intent && pullEventCallFact(event, intent) === 'not_called') intentStore.delete([key, intent.intentId]);
      for (const effectPage of effectPages) {
        if (effectPage.eventId === event.eventId) {
          effectStore.delete([key, String(effectPage.eventId), Number(effectPage.pageNumber)]);
        }
      }
    };
    for (const page of pages) {
      const pageId = String(page.pageId);
      if (String(page.state) === 'page_complete' || attached.has(pageId)) continue;
      const own = eventsOf(pageId);
      const facts = own.map((event) => pullEventCallFact(event, intentFor(event)));
      const blockedKnown = String(page.state) === 'blocked' && page.handover !== 'reconcile'
        && page.recoveryCode !== 'authority_reconcile' && facts.every((fact) => fact === 'known');
      if (blockedKnown) {
        discardedBlocked = true;
        for (const event of own) dropEvent(event);
        pageStore.delete([key, pageId]);
        diagnosticStore.put({ id: `pull-page-handover:${key}:${pageId}`, scopeKey: key, kind: 'pull_page_handover',
          code: 'stale_blocked_page_discarded', pageId, recoveryCode: page.recoveryCode ?? null,
          previousCursor: page.previousCursor, nextCursor: page.nextCursor, authorityCursor: cursor, at: Date.now() });
        continue;
      }
      own.forEach((event, index) => { if (facts[index] === 'not_called') dropEvent(event); });
      if (!facts.some((fact) => fact !== 'not_called')) {
        pageStore.delete([key, pageId]);
        diagnosticStore.put({ id: `pull-page-handover:${key}:${pageId}`, scopeKey: key, kind: 'pull_page_handover',
          code: 'stale_unapplied_page_retired', pageId, callFact: 'not_called', previousCursor: page.previousCursor,
          nextCursor: page.nextCursor, authorityCursor: cursor, at: Date.now() });
        continue;
      }
      pageStore.put({ ...page, state: 'blocked', handover: 'reconcile', recoveryCode: 'authority_reconcile',
        blockedAt: typeof page.blockedAt === 'number' ? page.blockedAt : Date.now(), authorityCursor: cursor });
      diagnosticStore.put({ id: `pull-page-handover:${key}:${pageId}`, scopeKey: key, kind: 'pull_page_handover',
        code: 'authority_reconcile_retained', pageId, callFact: 'unknown', previousCursor: page.previousCursor,
        nextCursor: page.nextCursor, authorityCursor: cursor, at: Date.now() });
    }
    const queued = await cursorPage<QueueOperation>(tx.objectStore(STORES.queue), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    for (const item of queued) {
      if (item.status === 'terminal' && (discardedBlocked || retiredOps.has(item.opId))) {
        await markQueuePullEchoApplied(tx, key, item.opId, maxRecordBytes);
      }
    }
    for (const ack of acks) {
      if (ack.kind !== 'pull' || ack.state !== 'pending' || ack.cursor === cursor) continue;
      ackStore.delete([key, ack.intentId]);
      diagnosticStore.put({ id: `pull-ack-handover:${key}:${ack.intentId}`, scopeKey: key, kind: 'pull_ack_handover',
        code: 'stale_pull_ack_handed_over', intentId: ack.intentId, cursor: ack.cursor, authorityCursor: cursor, at: Date.now() });
    }
  }

  /**
   * F007 cutover discard. `commitRecovery` swaps the staged Snapshot into live authority, so the
   * whole Pre-recovery Pull world is void: a surviving page (blocked or staged) would be neither
   * replayed nor completed, a staged event would be re-driven by `resumeApply` and land on Chrome
   * again, effect pages and their download ledgers describe an effect chain the Snapshot
   * supersedes, and an unexpired apply intent would make `preparePullIntent` reject the
   * re-delivered event with `intent_correlation_active`. Outbound queue rows, mappings and the
   * bootstrap Ack intent are deliberately left to their own cutover semantics,
   * except terminal queue rows: those are stamped `echoApplied` so a discarded
   * own-echo cannot resurrect a historical title as overlay.
   */
  async function discardPreRecoveryPullState(tx: IDBTransaction, key: string, snapshotId: string): Promise<void> {
    const rows = (name: string) => cursorPage<UnknownRecord>(tx.objectStore(name), scopeRowsRange(key),
      Number.MAX_SAFE_INTEGER);
    const [pages, events, intents] = await Promise.all([
      rows(STORES.pullPages), rows(STORES.pullEvents), rows(STORES.intents)]);
    for (const page of pages) {
      const issue = blockedPullIssue(page, events.filter(event => event.pageId === page.pageId));
      if (issue) for (const nodeId of issue.nodeIds) await putPullIssueFact(tx, key, {
        nodeId, code: issue.code, eventId: `snapshot-retained:${issue.pageId}`, now: issue.at,
      });
    }
    const unresolved = intents.filter(intent => intent.nativeResult === 'result_unknown'
      || intent.nativeResult === 'waiting_dependency' || intent.waitReason === 'native_result_unknown');
    const retainedEvents = new Set([...unresolved.map(intent => intent.eventId), ...events.filter(event => remoteDeleteDeferral(event)).map(event => String(event.eventId))]);
    const retainedPages = new Set(events.filter(event => retainedEvents.has(String(event.eventId))).map(event => event.pageId));
    const decisionPages = new Set(events.filter(event => remoteDeleteDeferral(event)).map(event => event.pageId));
    for (const name of [STORES.pullPages, STORES.pullEvents, STORES.effectPages, STORES.intents]) {
      if (name === STORES.pullPages && retainedPages.size) {
        for (const page of pages) {
          if (!retainedPages.has(page.pageId)) tx.objectStore(name).delete([key, String(page.pageId)]);
          else if (decisionPages.has(page.pageId)) tx.objectStore(name).put({ ...page, state: 'page_complete',
            snapshotAccountedBy: snapshotId, completedAt: Date.now() });
        }
      } else if (name === STORES.intents) {
        for (const intent of intents) if (!unresolved.includes(intent)) tx.objectStore(name).delete([key, String(intent.intentId)]);
      } else if (name === STORES.pullEvents) {
        for (const event of events) if (!retainedEvents.has(String(event.eventId))) tx.objectStore(name).delete([key, String(event.eventId)]);
      } else if (name === STORES.effectPages && retainedEvents.size) {
        await iterateCursor(tx.objectStore(name), scopeRowsRange(key), (value, cursor) => {
          if (!retainedEvents.has(String((value as UnknownRecord).eventId))) cursor.delete();
        });
      } else await deleteScopeRows(tx.objectStore(name), key);
    }
    // Effect-page download ledgers are keyed by effect, so range them by this scope's ids.
    await deleteByIndexRange(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
      IDBKeyRange.bound([key, `effect-download:${key}:`], [key, `effect-download:${key}:\uffff`]));

    if (pages.length + events.length + intents.length === 0) return;
    tx.objectStore(STORES.diagnostics).put({ id: `recovery-cutover:${key}`, scopeKey: key,
      kind: 'recovery_pre_apply_state_discarded', code: 'recovery_snapshot_cutover',
      pageCount: pages.length, blockedPageCount: pages.filter((page) => String(page.state) === 'blocked').length,
      eventCount: events.length, intentCount: intents.length, at: Date.now() });
  }

  async function stageRecoveryPage(input: SyncScope, pageInput: RecoveryPageInput): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const page = validateRecoveryPage(key, pageInput, maxRecordBytes);
    if (new Set(page.nodes.map((node) => node.colpId)).size !== page.nodes.length) {
      throw new SyncStateError('snapshot_node_duplicate');
    }
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.recovery, STORES.recoveryNodes, STORES.diagnostics],
      'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const recovery = tx.objectStore(STORES.recovery);
        const headerKey = [key, page.snapshotId]; const prior = await requestValue(recovery.get(headerKey)) as RecoveryHeader | undefined;
        if (page.page === 0 && prior) {
          if (prior.sessionId !== page.sessionId || prior.revision !== page.revision || prior.syncCursor !== page.syncCursor
            || prior.capability !== page.capability || prior.materializationVersion !== page.materializationVersion
            || prior.identityDigest !== page.identityDigest || prior.rootNodeId !== page.rootNodeId || prior.lastPage !== 0
            || prior.lastPageDigest !== page.pageDigest || prior.nextCursor !== page.nextCursor || prior.complete !== page.complete) {
            throw new SyncStateError('snapshot_identity_conflict');
          }
        } else if (page.page > 0) {
          if (!prior || prior.lastPage !== page.page - 1 || prior.lastPageDigest !== page.previousPageDigest || prior.complete) {
            throw new SyncStateError('page_chain_invalid');
          }
          // Recovery capability issuance occurs only after the server records the final page;
          // the page syncCursor must stay identical across the whole chain.
          if (prior.sessionId !== page.sessionId || prior.revision !== page.revision || prior.syncCursor !== page.syncCursor
              || prior.identityDigest !== page.identityDigest || prior.materializationVersion !== page.materializationVersion
              || prior.rootNodeId !== page.rootNodeId || (prior.capability !== page.capability && !page.complete)) {
            throw new SyncStateError('snapshot_identity_conflict');
          }
        }
        recovery.put({ scopeKey: key, snapshotId: page.snapshotId, sessionId: page.sessionId, revision: page.revision,
          syncCursor: page.syncCursor,
          ...(page.capability === undefined ? {} : { capability: page.capability }),
          ...(page.materializationVersion === undefined ? {} : { materializationVersion: page.materializationVersion }),
          identityDigest: page.identityDigest, rootNodeId: page.rootNodeId,
          lastPage: page.page, lastPageDigest: page.pageDigest,
          nextCursor: page.nextCursor, complete: page.complete });
        const nodes = tx.objectStore(STORES.recoveryNodes);
        for (const node of page.nodes) {
          const existing = await requestValue(nodes.get([key, page.snapshotId, node.colpId])) as RecoveryNodeRecord | undefined;
          if (existing && existing.page !== page.page) throw new SyncStateError('snapshot_node_duplicate');
        }
        await deleteByIndexRange(nodes.index(INDEXES.recoveryByPage), IDBKeyRange.bound(
          [key, page.snapshotId, page.page, ''], [key, page.snapshotId, page.page, '\uffff']));
        for (const node of page.nodes) {
          nodes.put({ ...node, scopeKey: key, snapshotId: page.snapshotId, page: page.page });
          if (node.mapping.quarantine) await putPullIssueFact(tx, key, { nodeId: node.colpId,
            code: node.mapping.quarantine.code, eventId: `snapshot:${page.snapshotId}:${node.colpId}`, now: Date.now() });
        }
      });
  }

  async function commitRecovery(input: SyncScope, snapshotId: string,
    ackInput?: Omit<AckIntentRecord, 'scopeKey' | 'state' | 'kind' | 'cursor'>): Promise<void> {
    assertWritable(); const scope = validateScope(input); const key = scopeKey(scope); boundedString(snapshotId, 'snapshotId');
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.mappings, STORES.queue, STORES.bookmarkEvents,
      STORES.cursors, STORES.recovery, STORES.recoveryNodes, STORES.ackIntents, STORES.pullPages, STORES.pullEvents,
      STORES.effectPages, STORES.intents, STORES.diagnostics, STORES.localSyncExclusions, STORES.remoteDeleteDecisions], 'readwrite', async (tx) => {
      const scopes = tx.objectStore(STORES.scopes); const current = await requireActiveScope(tx, key);
      const header = await requestValue(tx.objectStore(STORES.recovery).get([key, snapshotId])) as RecoveryHeader | undefined;
      if (!header?.complete || header.nextCursor !== null) throw new SyncStateError('recovery_incomplete');
      const mappings = tx.objectStore(STORES.mappings);
      const priorMappings = await cursorPage<MappingInput & { readonly scopeKey: string }>(mappings.index(INDEXES.mappingByNativeId),
        scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const priorByColpId = new Map(priorMappings.map((mapping) => [mapping.colpId, mapping]));
      const selectedNativeIds = current.selectedRoots.map((colpId) => priorByColpId.get(colpId)?.nativeId);
      if (selectedNativeIds.some((nativeId) => !nativeId)) throw new SyncStateError('snapshot_root_mapping_missing');
      const privateMappings = (current.privateRoots ?? []).map((colpId) => priorByColpId.get(colpId));
      if (privateMappings.some((mapping) => !mapping)) throw new SyncStateError('snapshot_root_mapping_missing');
      const queued = await cursorPage<QueueOperation>(tx.objectStore(STORES.queue), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const issueRoots = (await transactionIssueDependencies(tx.objectStore(STORES.queue), key)).roots;
      addQueueIssueRoots(issueRoots, queued);
      const issueProtected = issueProtectionIds(priorMappings, issueRoots);
      const locallyAdvanced = new Set<string>(issueProtected);
      for (const item of queued) {
        const target = extractOutstandingTarget(item);
        if (target) for (const colpId of target.colpIds) locallyAdvanced.add(colpId);
        if (item.status === 'terminal') await markQueuePullEchoApplied(tx, key, item.opId, maxRecordBytes);
      }
      // Removal callbacks captured while paused/frozen have no queue Sequence
      // yet. Their identities must survive this same atomic Snapshot cutover.
      const nativeDeletes = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents),
        scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const priorByNativeId = new Map(priorMappings.map(mapping => [mapping.nativeId, mapping]));
      for (const event of nativeDeletes) {
        if (event.status !== 'pending' || event.kind !== 'remove') continue;
        const ids = event.details.deleteNativeIds;
        for (const nativeId of [event.nativeId, ...(Array.isArray(ids) ? ids : [])]) {
          const mapping = typeof nativeId === 'string' ? priorByNativeId.get(nativeId) : undefined;
          if (mapping) locallyAdvanced.add(mapping.colpId);
        }
      }
      await deleteByIndexRange(mappings.index(INDEXES.mappingByNativeId), IDBKeyRange.bound([key, ''], [key, '\uffff']));
      const nodes = tx.objectStore(STORES.recoveryNodes).index(INDEXES.recoveryByPage);
      const projectedByNativeId = new Map<string, string>();
      const projectedByColpId = new Set<string>();
      await iterateCursor(nodes, IDBKeyRange.bound([key, snapshotId, 0], [key, snapshotId, Number.MAX_SAFE_INTEGER]), (value) => {
        const node = value as RecoveryNodeRecord; const staged = validateMappingRecord(key, node.mapping, maxRecordBytes);
        const mapping = locallyAdvanced.has(staged.colpId) ? priorByColpId.get(staged.colpId) ?? staged : staged;
        mappings.put(mapping); projectedByNativeId.set(mapping.nativeId, mapping.colpId);
        projectedByColpId.add(mapping.colpId);
      });
      for (const mapping of priorMappings) {
        if (!locallyAdvanced.has(mapping.colpId) || projectedByColpId.has(mapping.colpId)
            || projectedByNativeId.has(mapping.nativeId)) continue;
        mappings.put(mapping);
        if (issueProtected.has(mapping.colpId) && !/^(?:recovery:|sidecar:)/u.test(mapping.nativeId)) {
          tx.objectStore(STORES.localSyncExclusions).put({ scopeKey: key, nativeId: mapping.nativeId,
            decisionId: `snapshot-issue:${snapshotId}`, rootNativeId: mapping.rootNativeId,
            generation: scope.generation, priorColpId: mapping.colpId });
        }
        projectedByNativeId.set(mapping.nativeId, mapping.colpId);
        projectedByColpId.add(mapping.colpId);
      }
      for (const mapping of privateMappings as Array<MappingInput & { readonly scopeKey: string }>) mappings.put(mapping);
      const selectedRoots = selectedNativeIds.map((nativeId) => projectedByNativeId.get(nativeId!));
      if (selectedRoots.some((colpId) => !colpId)) throw new SyncStateError('snapshot_root_mapping_missing');
      scopes.put({ ...current, lifecycle: 'active', checkpoint: { serverRevision: header.revision,
        cursor: header.syncCursor }, selectedRoots: selectedRoots as string[] });
      tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: header.syncCursor,
        checkpoint: header.revision, evidence: { snapshotId, pageDigest: header.lastPageDigest,
          capability: header.capability, syncCursor: header.syncCursor } });
      if (ackInput) {
        if (header.sessionId !== null && ackInput.sessionId !== header.sessionId) {
          throw new SyncStateError('snapshot_session_scope_mismatch');
        }
        const intent = validateAckIntent({ ...ackInput, scopeKey: key, state: 'pending', kind: 'bootstrap',
          cursor: header.syncCursor });
        const intents = tx.objectStore(STORES.ackIntents);
        const prior = await requestValue(intents.get([key, intent.intentId])) as AckIntentRecord | undefined;
        if (prior && !sameAckIntent(prior, intent)) throw new SyncStateError('ack_intent_reuse');
        if (!prior) intents.add(intent);
      }
      await deleteByIndexRange(nodes, IDBKeyRange.bound([key, snapshotId, 0],
        [key, snapshotId, Number.MAX_SAFE_INTEGER, '\uffff']));
      await discardPreRecoveryPullState(tx, key, snapshotId);
      tx.objectStore(STORES.recovery).delete([key, snapshotId]);
    }); durableCache.set(key, { recovery: snapshotId });
  }

  async function discardRecoveryStaging(input: SyncScope): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.recovery, STORES.recoveryNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      await deleteScopeRows(tx.objectStore(STORES.recovery), key);
      await deleteScopeRows(tx.objectStore(STORES.recoveryNodes), key);
    });
  }

  async function rebaseRecoveryCursor(input: SyncScope, capability: string,
    checkpoint: { readonly cursor: string; readonly serverRevision: string }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const recoveryCursor = boundedString(capability, 'capability');
    const cursor = boundedString(checkpoint.cursor, 'serverCursor');
    const serverRevision = boundedString(checkpoint.serverRevision, 'serverRevision'); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.cursors, STORES.ackIntents, STORES.pullPages, STORES.pullEvents,
      STORES.effectPages, STORES.intents, STORES.diagnostics, STORES.queue], 'readwrite', async (tx) => {
      const scopes = tx.objectStore(STORES.scopes); const current = await requireActiveScope(tx, key);
      const cursors = tx.objectStore(STORES.cursors); const prior = await requestValue(cursors.get(key)) as UnknownRecord | undefined;
      const intents = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const evidence = prior?.evidence && typeof prior.evidence === 'object' ? prior.evidence as UnknownRecord : {};
      const syncCursor = typeof evidence.syncCursor === 'string' ? evidence.syncCursor : null;
      // The capability is bound to the staged snapshot evidence; the completed bootstrap Ack
      // intent acknowledges the stable page syncCursor, not the capability token.
      const recoveryComplete = syncCursor !== null && intents.some((intent) => intent.kind === 'bootstrap'
        && intent.state === 'complete' && intent.cursor === syncCursor);
      const alreadyActivated = prior?.cursor === cursor && current.checkpoint?.cursor === cursor
        && current.checkpoint.serverRevision === serverRevision;
      if ((!alreadyActivated && prior?.cursor !== syncCursor) || !recoveryCursor.startsWith('src1.')
          || typeof evidence.snapshotId !== 'string' || evidence.capability !== recoveryCursor
          || !recoveryComplete) throw new SyncStateError('recovery_rebase_invalid');
      if (!alreadyActivated) {
        cursors.put({ ...prior, cursor, checkpoint: serverRevision });
        scopes.put({ ...current, checkpoint: { cursor, serverRevision } });
      }
      await handOverSupersededPullAuthority(tx, key, cursor, current);
    }); durableCache.set(key, { cursor });
  }

  async function rebaseActiveSessionAuthority(input: SyncScope,
    checkpoint: { readonly cursor: string; readonly serverRevision: string;
      readonly expectedEngineRevision?: number; readonly requireConfirmedCursor?: string }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const cursor = boundedString(checkpoint.cursor, 'serverCursor');
    const serverRevision = boundedString(checkpoint.serverRevision, 'serverRevision'); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.cursors, STORES.engine, STORES.pullPages, STORES.pullEvents,
      STORES.effectPages, STORES.intents, STORES.ackIntents, STORES.diagnostics, STORES.queue], 'readwrite', async (tx) => {
      const scopes = tx.objectStore(STORES.scopes); const current = await requireActiveScope(tx, key);
      const engine = await requestValue(tx.objectStore(STORES.engine).get(key)) as DurableSyncEngineState | undefined;
      if (checkpoint.expectedEngineRevision !== undefined
          && engine?.revision !== checkpoint.expectedEngineRevision) throw new SyncStateError('engine_revision_stale');
      if (!engine?.authorityRefreshRequired || !engine.recoveryFrozen) {
        throw new SyncStateError('authority_rebase_not_required');
      }
      if (checkpoint.requireConfirmedCursor !== undefined) {
        const durable = await requestValue(tx.objectStore(STORES.cursors).get(key)) as
          { cursor?: string; evidence?: unknown } | undefined;
        const acks = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        const pages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullPages), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        const intents = await cursorPage<IntentRecord>(tx.objectStore(STORES.intents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        if (durable?.cursor !== checkpoint.requireConfirmedCursor
            || acks.some(ack => ack.state === 'pending')
            || !durable || !cursorIsConfirmed(durable, engine.lastAckedCursor, acks)
            || pages.some(page => page.state !== 'page_complete')
            || intents.some(intent => intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown')) {
          throw new SyncStateError('session_handoff_pending');
        }
      }
      tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor, checkpoint: serverRevision,
        evidence: { sessionAuthority: true } });
      scopes.put({ ...current, lifecycle: 'active', checkpoint: { cursor, serverRevision } });
      await handOverSupersededPullAuthority(tx, key, cursor, current);
    }); durableCache.set(key, { cursor });
  }

  async function finalizeRecoveryMappings(input: SyncScope, snapshotId: string,
    mappingInput: readonly MappingInput[]): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(snapshotId, 'snapshotId');
    const mappings = mappingInput.map((mapping) => validateMapping(key, mapping, maxRecordBytes));
    if (new Set(mappings.map((mapping) => mapping.colpId)).size !== mappings.length) {
      throw new SyncStateError('snapshot_node_duplicate');
    }
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.recovery,
      STORES.recoveryNodes, STORES.queue, ...ISSUE_DEPENDENCY_STORES], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const header = await requestValue(
        tx.objectStore(STORES.recovery).get([key, snapshotId])) as RecoveryHeader | undefined;
      if (!header?.complete || header.nextCursor !== null) throw new SyncStateError('recovery_incomplete');
      const nodes = tx.objectStore(STORES.recoveryNodes); const staged = await cursorPage<RecoveryNodeRecord>(
        nodes.index(INDEXES.recoveryByPage), IDBKeyRange.bound([key, snapshotId, 0],
          [key, snapshotId, Number.MAX_SAFE_INTEGER]), Number.MAX_SAFE_INTEGER);
      const byColpId = new Map(mappings.map((mapping) => [mapping.colpId, mapping]));
      const roots = (await transactionIssueDependencies(tx.objectStore(STORES.queue), key)).roots;
      const priorMappings = await requestValue<MappingInput[]>(tx.objectStore(STORES.mappings).getAll(scopeRowsRange(key)));
      addQueueIssueRoots(roots, await requestValue<QueueOperation[]>(tx.objectStore(STORES.queue).getAll(scopeRowsRange(key))));
      const protectedIds = issueProtectionIds(priorMappings, roots);
      const stagedIds = new Set(staged.map(node => node.colpId));
      if (staged.some((node) => !byColpId.has(node.colpId))
          || mappings.some(row => !stagedIds.has(row.colpId) && !protectedIds.has(row.colpId))) {
        throw new SyncStateError('snapshot_projection_incomplete');
      }
      for (const node of staged) nodes.put({ ...node, mapping: byColpId.get(node.colpId)! });
    });
  }

  async function getRecoveryHeader(input: SyncScope): Promise<RecoveryHeader | null> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.recovery, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<RecoveryHeader>(tx.objectStore(STORES.recovery), scopeRowsRange(key), 1);
    await completion; return rows[0] ? clone(rows[0]) : null;
  }

  async function listRecoveryNodes(input: SyncScope): Promise<RecoveryNodeRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.recoveryNodes, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<RecoveryNodeRecord>(tx.objectStore(STORES.recoveryNodes),
      scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
    await completion; return clone(rows);
  }

  return { hasRecoveryStaging, stageRecoveryPage, commitRecovery, discardRecoveryStaging,
    rebaseRecoveryCursor, rebaseActiveSessionAuthority, finalizeRecoveryMappings,
    getRecoveryHeader, listRecoveryNodes };
}

