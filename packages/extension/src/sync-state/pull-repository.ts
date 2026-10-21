import { pullDeferral, validatedPullDeferral } from '../pull-deferral.js';
import { createProjectionRepository } from './projection-repository.js';
import { mergeRemoteObservation } from './remote-observation.js';
import { classifyDurablePullCursorWrite, pullPageDiagnosticRow, type PullCursorWriteClass } from '../pull-ack-boundary.js';
import {
  SyncStateError, type EffectPageDownloadRecord, type FaultOptions, type IntentRecord, type JsonObject, type JsonValue,
  type MappingInput, type MountBindingRecord, type PullApplyState, type PullPageInput,
  type ReceiptRecord, type RemoteObservationRecord, type ScopeCommandPlanRecord, type SyncScope, type UnknownRecord,
} from './types.js';
import { boundedString, canonicalJson, clone, validateJson } from './codec.js';
import { constraintError, inject } from './errors.js';
import {
  cursorPage, iterateCursor, iterateCursorSequentially, pageEventsRange, requestValue, requireActiveScope, runTransaction, scopeRowsRange,
  transactionDone,
} from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { adoptBlockedPagesAtChainHead, pullEventCallFact } from './recovery-repository.js';
import { validateMapping, validateMappingRecord } from './mapping-repository.js';
import { planPullMappingWrites } from './pull-mapping-writes.js';
import { validateQueueRecord, validateReceipt } from './queue-validate.js';
import { settleResolvedConflictQueue } from './queue-hold.js';
import { settleConflictPullIssue } from './pull-issue-repository.js';
import { markQueuePullEchoApplied } from './pull-queue-echo.js';
import { hasQueueRevisionForTarget } from './queue-live-work.js';
import { sameEffectPageRecord, samePullEventRecord, uniqueExclusions, validateCursor,
  validateIntent, validatePullPage } from './pull-validate.js';
import { validateLocalSyncExclusion, type LocalSyncExclusionRecord } from './remote-delete-repository.js';
import { validateMountBinding } from './mount-repository.js';
import { validateRemoteObservation, validateScopeCommandPlan } from './scope-facts-repository.js';
import {
  coveredPullOperationIds, probePullState, pruneCompletedPullPages, putPullTerminalFacts, pullHistoryLimits,
  PULL_HISTORY_PAGE_KEEP, readOrderedPullEvents, readPullApplyWorkset, readPullPagesByState, type PullHistoryBudget,
} from './pull-workset.js';
import type { SyncStoreRuntime } from './runtime.js';

function intentStateAfterObservation(eventState: unknown): 'native_event_observed' | 'authority_committed' | 'page_complete' {
  if (eventState === 'page_complete') return 'page_complete';
  if (eventState === 'authority_committed') return 'authority_committed';
  return 'native_event_observed';
}

export function createPullRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function createApplyIntent(input: SyncScope, intentInput: Record<string, unknown>): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const intent = validateIntent(key, intentInput, maxRecordBytes);
    const db = await writableDatabase(); try { await runTransaction(db, [STORES.scopes, STORES.intents], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); tx.objectStore(STORES.intents).add(intent);
    }); } catch (error) { throw constraintError(error); }
  }

  async function getApplyIntent(input: SyncScope, intentId: string) {
    return ctx.readOne(STORES.intents, [scopeKey(validateScope(input)), boundedString(intentId, 'intentId')]) as Promise<IntentRecord | null>;
  }

  async function findApplyIntent(input: SyncScope, correlationId: string) {
    const key = scopeKey(validateScope(input)); boundedString(correlationId, 'correlationId'); const db = await open();
    const tx = db.transaction(STORES.intents, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.intents).index(INDEXES.intentByCorrelation)
    .get([key, correlationId])); await completion; return value ? clone(value) : null;
  }

  async function hasActiveApplyIntentForNativeTarget(input: SyncScope, nativeId: string) {
    const key = scopeKey(validateScope(input)); const target = boundedString(nativeId, 'nativeId'); const db = await open();
    const tx = db.transaction(STORES.intents, 'readonly'); const completion = transactionDone(tx);
    const values = await intentsForNativeTarget(tx, key, target);
    await completion; const timestamp = Date.now();
    return values.some((intent) => intent.nativeTargetId === target && intent.expiresAt > timestamp
      && ['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete']
        .includes(String(intent.state)));
  }

  async function stagePullPage(input: SyncScope, pageInput: PullPageInput): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const page = validatePullPage(key, pageInput, maxRecordBytes);
    const db = await writableDatabase(); await runTransaction(db,
      [STORES.scopes, STORES.cursors, STORES.pullPages, STORES.pullEvents, STORES.effectPages,
        STORES.diagnostics], 'readwrite', async (tx) => {
        const current = await requireActiveScope(tx, key); const cursor = await requestValue(tx.objectStore(STORES.cursors).get(key)) as
          { readonly cursor?: string } | undefined;
        if ((cursor?.cursor ?? current.checkpoint?.cursor) !== page.previousCursor) throw new SyncStateError('pull_cursor_discontinuous');
        const pages = tx.objectStore(STORES.pullPages); const existing = await requestValue(pages.get([key, page.pageId]));
        if (existing) {
          const { completedAt: _completedAt, recoveryCode: _recoveryCode, blockedAt: _blockedAt, ...stored } = existing as UnknownRecord;
          const replay = { ...stored, state: 'staged' }; const blockedReplay = String(stored.state) === 'blocked';
          if ((!blockedReplay && !['staged', 'page_complete'].includes(String(stored.state)))
              || canonicalJson(replay) !== canonicalJson(page)) throw new SyncStateError('pull_page_reuse');
          if (blockedReplay) { pages.put(replay); // a blocked page replays (keeping committed event state) instead of dangling
            tx.objectStore(STORES.diagnostics).put(pullPageDiagnosticRow({ scopeKey: key, kind: 'pull_page_retry',
              code: String(existing.recoveryCode ?? 'blocked'), pageId: page.pageId,
              previousCursor: page.previousCursor, nextCursor: page.nextCursor })); }
          return;
        }
        await adoptBlockedPagesAtChainHead(tx, key, page);
        pages.add(page);
        const events = tx.objectStore(STORES.pullEvents); const effects = tx.objectStore(STORES.effectPages);
        for (const event of page.events) {
          const prior = await requestValue(events.get([key, event.eventId])) as UnknownRecord | undefined;
          if (!prior) { events.add(event); putPullTerminalFacts(tx, key, event as UnknownRecord); continue; }
          putPullTerminalFacts(tx, key, prior);
          if (prior.pageId !== page.pageId || !samePullEventRecord(prior, event)) throw new SyncStateError('pull_event_conflict');
        }
        for (const effectPage of page.effectPages) {
          const prior = await requestValue(effects.get([key, effectPage.eventId, effectPage.pageNumber])) as UnknownRecord | undefined;
          if (!prior) { effects.add(effectPage); continue; }
          if (prior.pageId !== page.pageId || !sameEffectPageRecord(prior, effectPage)) throw new SyncStateError('pull_event_conflict');
        }
      });
  }

  async function listPullEvents(input: SyncScope, states?: readonly PullApplyState[]) {
    const key = scopeKey(validateScope(input)); const db = await open();
    return clone(await readOrderedPullEvents(db, key, states));
  }

  async function listPullEventsByPage(input: SyncScope, pageId: string) {
    const key = scopeKey(validateScope(input)); boundedString(pageId, 'pageId');
    const db = await open(); const tx = db.transaction(STORES.pullEvents, 'readonly');
    const completion = transactionDone(tx);
    const values = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByPage),
      pageEventsRange(key, pageId), Number.MAX_SAFE_INTEGER); await completion;
    return clone(values);
  }

  async function hasPullEventsAwaitingConfirmation(input: SyncScope): Promise<boolean> {
    // SYNC-F011: existence only. The state index returns on the first row.
    const key = scopeKey(validateScope(input));
    const db = await open(); const tx = db.transaction([STORES.pullEvents, STORES.remoteDeleteDecisions, STORES.intents], 'readonly');
    const done = transactionDone(tx);
    let blocking = false; let after: string | undefined;
    for (;;) {
      const [event] = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByState),
        IDBKeyRange.bound(after === undefined ? [key, 'awaiting_confirmation'] : [key, 'awaiting_confirmation', after],
          [key, 'awaiting_confirmation', []], after !== undefined), 1);
      if (!event) break;
      if (!await validatedPullDeferral(tx, key, event, input.generation)) { blocking = true; break; }
      after = String(event.eventId);
    }
    await done; return blocking;
  }

  async function getPullEvent(input: SyncScope, eventId: string) {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.pullEvents, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.pullEvents).get([key, boundedString(eventId, 'eventId')]));
    await completion; return clone((value as UnknownRecord | undefined) ?? null);
  }

  async function listPullPages(input: SyncScope, states?: readonly string[]) {
    const key = scopeKey(validateScope(input)); const db = await open();
    if (states && states.length > 0) return clone(await readPullPagesByState(db, key, states));
    const tx = db.transaction(STORES.pullPages, 'readonly'); const completion = transactionDone(tx);
    const values: UnknownRecord[] = [];
    await iterateCursor(tx.objectStore(STORES.pullPages), scopeRowsRange(key), (value) => { values.push(value as UnknownRecord); });
    await completion; return clone(values);
  }

  async function loadPullApplyWorkset(input: SyncScope) {
    return readPullApplyWorkset(await open(), scopeKey(validateScope(input)));
  }

  /** Bound completed Pull pages by page count, event count, and stored bytes. */
  async function prunePullHistory(input: SyncScope, keep = PULL_HISTORY_PAGE_KEEP,
    budget?: PullHistoryBudget): Promise<number> {
    assertWritable(); const key = scopeKey(validateScope(input)); const limits = pullHistoryLimits(keep, budget);
    const db = await writableDatabase(); let removed = 0;
    await runTransaction(db, [STORES.scopes, STORES.pullPages, STORES.pullEvents, STORES.effectPages, STORES.queue,
      STORES.diagnostics, STORES.ackIntents, STORES.intents], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      removed = await pruneCompletedPullPages(tx, key, limits, maxRecordBytes);
    });
    return removed;
  }

  async function pullOperationsCovered(input: SyncScope, opIds: readonly string[]): Promise<readonly string[]> {
    const key = scopeKey(validateScope(input));
    const unique = [...new Set(opIds.map((opId) => boundedString(opId, 'opId')))];
    if (unique.length === 0) return [];
    return coveredPullOperationIds(await open(), key, unique);
  }

  /** Targeted single-store reads for engine wakes; exportScope reads every store and is for evidence/recovery. */
  async function getCursor(input: SyncScope): Promise<{ readonly cursor?: string; readonly evidence?: unknown } | null> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.cursors, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.cursors).get(key)); await completion;
    return clone((value as { cursor?: string; evidence?: unknown } | undefined) ?? null);
  }

  async function preparePullIntent(input: SyncScope, eventId: string, intentInput: Record<string, unknown>): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const intent = validateIntent(key, intentInput, maxRecordBytes);
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.pullEvents, STORES.intents],
      'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, boundedString(eventId, 'eventId')])) as UnknownRecord | undefined;
        if (!event || event.state !== 'staged') throw new SyncStateError('pull_event_state_invalid');
        const intents = tx.objectStore(STORES.intents); const prior = await requestValue(intents.index(INDEXES.intentByCorrelation)
          .get([key, intent.correlationId])) as IntentRecord | undefined;
        if (prior && prior.expiresAt > Date.now()
            && ['intent_prepared', 'browser_call_started', 'native_event_observed'].includes(String(prior.state))) {
          throw new SyncStateError('intent_correlation_active');
        }
        if (prior) intents.delete([key, prior.intentId]);
        intents.add(intent); events.put({ ...event, state: 'intent_prepared', intentId: intent.intentId });
      });
  }

  async function markPullBrowserCallStarted(input: SyncScope, eventId: string): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    await runTransaction(db, [STORES.pullEvents, STORES.intents], 'readwrite', async (tx) => {
      const events = tx.objectStore(STORES.pullEvents); const event = await requestValue(events.get([key, eventId])) as UnknownRecord | undefined;
      if (!event || event.state !== 'intent_prepared') throw new SyncStateError('pull_event_state_invalid');
      const intents = tx.objectStore(STORES.intents); const intent = await requestValue(intents.get([key, event.intentId as string])) as IntentRecord;
      if (!intent) throw new SyncStateError('intent_not_found');
      intents.put({ ...intent, state: 'browser_call_started', apiPhase: 'browser_call_started' });
      events.put({ ...event, state: 'browser_call_started' });
    });
  }

  async function observeApplyIntentEvent(input: SyncScope, correlationId: string, evidence: JsonObject,
    allowCompletedChangeEcho = true): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase(); let matched = false;
    await runTransaction(db, [STORES.intents, STORES.pullEvents], 'readwrite', async (tx) => {
      const intents = tx.objectStore(STORES.intents); const intent = await requestValue(intents.index(INDEXES.intentByCorrelation)
        .get([key, boundedString(correlationId, 'correlationId')])) as IntentRecord | undefined;
      if (!intent || intent.expiresAt <= Date.now() || !['browser_call_started', 'native_event_observed',
        'authority_committed', 'page_complete'].includes(String(intent.state)) || !intent.eventId) return;
      if (!allowCompletedChangeEcho && intent.expected.kind === 'change' && intent.state === 'page_complete') return;
      const events = tx.objectStore(STORES.pullEvents); const event = await requestValue(events.get([key, intent.eventId])) as UnknownRecord | undefined;
      if (!event || !['browser_call_started', 'native_event_observed', 'authority_committed',
        'page_complete'].includes(String(event.state))) return;
      if (intent.nativeEventEvidence && canonicalJson(intent.nativeEventEvidence) !== canonicalJson(evidence)) return;
      const state = intentStateAfterObservation(event.state);
      intents.put({ ...intent, state, apiPhase: state, nativeEventEvidence: clone(evidence) });
      if (event.state === 'browser_call_started') events.put({ ...event, state: 'native_event_observed' }); matched = true;
    }); return matched;
  }

  async function observeApplyIntentPostState(input: SyncScope, nativeId: string, postStateDigest: string,
    evidence: JsonObject, allowCompletedChangeEcho = true): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase(); let matched = false;
    await runTransaction(db, [STORES.intents, STORES.pullEvents], 'readwrite', async (tx) => {
      const intents = tx.objectStore(STORES.intents); const candidates = (await intentsForNativeTarget(
        tx, key, nativeId)).filter((intent) => intent.expiresAt > Date.now()
          && intent.nativeTargetId === boundedString(nativeId, 'nativeId')
          && intent.expectedPostState?.digest === boundedString(postStateDigest, 'postStateDigest')
          && (allowCompletedChangeEcho || intent.expected.kind !== 'change' || intent.state !== 'page_complete')
          && ['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete']
            .includes(String(intent.state)) && intent.eventId);
      if (candidates.length !== 1) return;
      const intent = candidates[0]!; const events = tx.objectStore(STORES.pullEvents);
      const event = await requestValue(events.get([key, intent.eventId!])) as UnknownRecord | undefined;
      if (!event || !['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete']
        .includes(String(event.state))) return;
      if (intent.nativeEventEvidence && canonicalJson(intent.nativeEventEvidence) !== canonicalJson(evidence)) return;
      const state = intentStateAfterObservation(event.state);
      intents.put({ ...intent, state, apiPhase: state, nativeEventEvidence: clone(evidence) });
      if (event.state === 'browser_call_started') events.put({ ...event, state: 'native_event_observed' }); matched = true;
    }); return matched;
  }

  async function observeApplyIntentChangeFields(input: SyncScope, nativeId: string,
    changes: Readonly<Record<string, string>>, allowCompletedChangeEcho = true): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input)); const target = boundedString(nativeId, 'nativeId');
    const entries = Object.entries(changes); if (entries.length === 0 || entries.some(([field]) => !['title', 'url'].includes(field))) return false;
    const db = await writableDatabase(); let matched = false;
    await runTransaction(db, [STORES.intents, STORES.pullEvents], 'readwrite', async (tx) => {
      const intents = tx.objectStore(STORES.intents); const candidates = (await intentsForNativeTarget(
        tx, key, target)).filter((intent) => {
          const expected = intent.expectedPostState?.nativeContent;
          return intent.expiresAt > Date.now() && intent.expected.kind === 'change' && intent.nativeTargetId === target
            && (allowCompletedChangeEcho || intent.state !== 'page_complete')
            && expected && typeof expected === 'object' && !Array.isArray(expected)
            && entries.every(([field, value]) => (expected as JsonObject)[field] === value)
            && ['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete']
              .includes(String(intent.state)) && intent.eventId;
        });
      if (candidates.length !== 1) return;
      const intent = candidates[0]!; const events = tx.objectStore(STORES.pullEvents);
      const event = await requestValue(events.get([key, intent.eventId!])) as UnknownRecord | undefined;
      if (!event || !['browser_call_started', 'native_event_observed', 'authority_committed', 'page_complete']
        .includes(String(event.state))) return;
      const evidence = { eventDigest: intent.correlationId, nativeId: target };
      if (intent.nativeEventEvidence && canonicalJson(intent.nativeEventEvidence) !== canonicalJson(evidence)) return;
      const state = intentStateAfterObservation(event.state);
      intents.put({ ...intent, state, apiPhase: state, nativeEventEvidence: evidence });
      if (event.state === 'browser_call_started') events.put({ ...event, state: 'native_event_observed' }); matched = true;
    }); return matched;
  }

  async function recordPullApiEvidence(input: SyncScope, eventId: string, evidence: JsonObject): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    await runTransaction(db, [STORES.pullEvents, STORES.intents], 'readwrite', async (tx) => {
      const events = tx.objectStore(STORES.pullEvents); const event = await requestValue(events.get([key, eventId])) as UnknownRecord | undefined;
      if (!event || !['browser_call_started', 'native_event_observed'].includes(String(event.state)) || !event.intentId) {
        throw new SyncStateError('pull_event_state_invalid');
      }
      const intents = tx.objectStore(STORES.intents); const intent = await requestValue(intents.get([key, event.intentId as string])) as IntentRecord;
      if (!intent) throw new SyncStateError('intent_not_found');
      const nativeId = (evidence as { readonly nativeId?: unknown }).nativeId;
      intents.put({ ...intent, state: 'native_event_observed', apiPhase: 'native_event_observed',
        apiResultEvidence: validateJson(evidence, 'apiResultEvidence') as JsonObject,
        ...(typeof nativeId === 'string' ? {
          nativeResult: 'applied_with_evidence' as const, replayState: 'awaiting_receipt' as const,
          nativeResultConfirmation: { kind: 'api_return' as const, nativeId },
        } : {}) });
      events.put({ ...event, state: 'native_event_observed' });
    });
  }

  async function commitPullEvent(input: SyncScope, eventId: string, update: { readonly mappings?: readonly MappingInput[];
    readonly deleteNativeIds?: readonly string[]; readonly apiResultEvidence?: JsonObject;
    readonly observations?: readonly Omit<RemoteObservationRecord, 'scopeKey'>[];
    readonly rangeExit?: {
      readonly observation: Omit<RemoteObservationRecord, 'scopeKey'>;
      readonly exclusion?: Omit<LocalSyncExclusionRecord, 'scopeKey'>;
      readonly exclusions?: readonly Omit<LocalSyncExclusionRecord, 'scopeKey'>[];
      readonly command?: Omit<ScopeCommandPlanRecord, 'scopeKey'>;
      readonly unbindNativeIds?: readonly string[];
      readonly mountBindings?: readonly Omit<MountBindingRecord, 'scopeKey'>[];
    };
  }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    const mappings = (update.mappings ?? []).map((raw) => validateMapping(key, raw, maxRecordBytes));
    const deleteNativeIds = (update.deleteNativeIds ?? []).map((nativeId) => boundedString(nativeId, 'nativeId'));
    const observations = (update.observations ?? []).map(row =>
      validateRemoteObservation(key, { ...row, scopeKey: key }, maxRecordBytes));
    const rangeExitExclusions = update.rangeExit
      ? uniqueExclusions([
        ...(update.rangeExit.exclusion ? [update.rangeExit.exclusion] : []),
        ...(update.rangeExit.exclusions ?? []),
      ].map((row) => validateLocalSyncExclusion(key, { ...row, scopeKey: key }, maxRecordBytes))) : [];
    const rangeExit = update.rangeExit ? {
      observation: validateRemoteObservation(key, { ...update.rangeExit.observation, scopeKey: key }, maxRecordBytes),
      ...(rangeExitExclusions[0] ? { exclusion: rangeExitExclusions[0] } : {}),
      ...(rangeExitExclusions.length ? { exclusions: rangeExitExclusions } : {}),
      ...(update.rangeExit.command ? {
        command: validateScopeCommandPlan(key, { ...update.rangeExit.command, scopeKey: key }, maxRecordBytes),
      } : {}),
      ...(update.rangeExit.unbindNativeIds?.length ? {
        unbindNativeIds: update.rangeExit.unbindNativeIds.map((id) => boundedString(id, 'nativeId')),
      } : {}),
      ...(update.rangeExit.mountBindings?.length ? {
        mountBindings: update.rangeExit.mountBindings.map((row) =>
          validateMountBinding(key, { ...row, scopeKey: key }, maxRecordBytes)),
      } : {}),
    } : undefined;
    await runTransaction(db, [STORES.scopes, STORES.pullEvents, STORES.intents, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const events = tx.objectStore(STORES.pullEvents);
      const event = await requestValue(events.get([key, boundedString(eventId, 'eventId')])) as UnknownRecord | undefined;
      if (!event || !['intent_prepared', 'browser_call_started', 'native_event_observed'].includes(String(event.state))) {
        throw new SyncStateError('pull_event_state_invalid');
      }
      if (event.intentId) { const intents = tx.objectStore(STORES.intents);
        const intent = await requestValue(intents.get([key, event.intentId as string])) as IntentRecord | undefined;
        if (intent) intents.put({ ...intent, state: 'authority_committed', apiPhase: 'authority_committed',
          apiResultEvidence: update.apiResultEvidence ?? null }); }
      const committed = { ...event, state: 'authority_committed', pendingMappings: mappings,
        pendingObservations: observations, pendingDeleteNativeIds: deleteNativeIds, apiResultEvidence: update.apiResultEvidence ?? null,
        ...(rangeExit ? { pendingRangeExit: rangeExit } : {}) };
      events.put(committed); putPullTerminalFacts(tx, key, committed);
    });
  }

  async function completePullPage(input: SyncScope, pageId: string, detachedEventId?: string): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    let blocked: 'concurrent_local_mutation' | 'mapping_identity_conflict' | PullCursorWriteClass | undefined;
    await runTransaction(db, [STORES.scopes, STORES.cursors, STORES.pullPages, STORES.pullEvents, STORES.intents,
      STORES.mappings, STORES.queue, STORES.receipts, STORES.remoteObservations, STORES.localSyncExclusions,
      STORES.scopeCommandPlans, STORES.mounts, STORES.diagnostics, STORES.remoteDeleteDecisions], 'readwrite', async (tx) => {
      const scopes = tx.objectStore(STORES.scopes); const current = await requireActiveScope(tx, key);
      const pages = tx.objectStore(STORES.pullPages); const page = await requestValue(pages.get([key, pageId])) as UnknownRecord | undefined;
      if (!page || page.state !== (detachedEventId ? 'page_complete' : 'staged')) throw new SyncStateError('pull_page_state_invalid');
      const allPageEvents = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByPage),
        pageEventsRange(key, pageId), Number.MAX_SAFE_INTEGER);
      const deferred = new Set<string>();
      for (const event of allPageEvents) {
        if (await validatedPullDeferral(tx, key, event, input.generation)) deferred.add(String(event.eventId));
      }
      const pageEvents = detachedEventId ? allPageEvents.filter(event => event.eventId === detachedEventId)
        : allPageEvents.filter(event => event.state !== 'awaiting_confirmation' || !deferred.has(String(event.eventId)));
      if ((detachedEventId ? pageEvents.length !== 1 || !deferred.has(detachedEventId) : allPageEvents.length !== page.eventCount)
          || pageEvents.some((event) => event.state !== 'authority_committed')) {
        throw new SyncStateError('pull_page_incomplete');
      }
      // F008: never publish a cursor behind the durable/recovery authority.
      const cursorRow = await requestValue(tx.objectStore(STORES.cursors).get(key)) as { readonly cursor?: string } | undefined;
      const publishedCursor = cursorRow?.cursor ?? current.checkpoint?.cursor ?? null;
      const cursorWrite = classifyDurablePullCursorWrite({ publishedCursor, previousCursor: String(page.previousCursor),
        nextCursor: String(page.nextCursor) });
      if (!detachedEventId && cursorWrite !== 'allow') blocked = cursorWrite;
      const mappings = tx.objectStore(STORES.mappings);
      const projectionState = new Map<string, string | null>();
      const preservedMappings = new Set<string>();
      if (detachedEventId) for (const event of pageEvents) {
        const payload = event.payload as UnknownRecord; const effect = payload.effect as UnknownRecord;
        const target = (effect.node as UnknownRecord | undefined)?.id
          ?? (effect.tombstone as UnknownRecord | undefined)?.targetId ?? (effect.rootTombstone as UnknownRecord | undefined)?.targetId;
        for (const mapping of event.pendingMappings as MappingInput[] ?? []) if (mapping.colpId !== target) preservedMappings.add(mapping.nativeId);
      }
      const queue = tx.objectStore(STORES.queue);
      for (const event of pageEvents) { if (!event.intentId || detachedEventId) continue;
        const intent = await requestValue(tx.objectStore(STORES.intents).get([key, event.intentId as string])) as IntentRecord | undefined;
        if (intent && !['create', 'sidecar'].includes(intent.expected.kind) && intent.nativeTargetId && intent.preStateDigest) {
          if (!projectionState.has(intent.nativeTargetId)) { const currentMapping = await requestValue(
            mappings.get([key, intent.nativeTargetId])) as { readonly projection?: { readonly digest?: string } } | undefined;
            projectionState.set(intent.nativeTargetId, currentMapping?.projection?.digest ?? null); }
          if (projectionState.get(intent.nativeTargetId) !== intent.preStateDigest) {
            const rawMapping = await requestValue(mappings.get([key, intent.nativeTargetId]));
            const currentMapping = rawMapping ? validateMappingRecord(key, rawMapping, maxRecordBytes) : null;
            const advanced = currentMapping !== null && await hasQueueRevisionForTarget(
              queue, key, currentMapping.colpId, currentMapping.projection.revision);
            if (!advanced) { blocked ??= 'concurrent_local_mutation'; break; }
            preservedMappings.add(intent.nativeTargetId);
          }
        }
        for (const mapping of (event.pendingMappings as Array<{ readonly nativeId: string;
          readonly projection: { readonly digest: string } }> | undefined) ?? []) {
          if (!preservedMappings.has(mapping.nativeId)) projectionState.set(mapping.nativeId, mapping.projection.digest); }
        for (const nativeId of (event.pendingDeleteNativeIds as string[] | undefined) ?? []) projectionState.set(nativeId, null);
      }
      const planned = blocked ? { blocked: true as const, writes: [] }
        : await planPullMappingWrites(mappings, key, pageEvents, preservedMappings, tx.objectStore(STORES.mounts));
      if (planned.blocked && !blocked) blocked = 'mapping_identity_conflict';
      if (blocked) { pages.put({ ...page, state: 'blocked', recoveryCode: blocked, blockedAt: Date.now() });
        scopes.put({ ...current, lifecycle: 'recovery_required', metadata: { ...(current.metadata ?? {}),
          recoveryCode: blocked } });
        tx.objectStore(STORES.diagnostics).put(pullPageDiagnosticRow({ scopeKey: key, kind: 'pull_page_blocked',
          code: blocked, pageId, previousCursor: page.previousCursor, nextCursor: page.nextCursor,
          publishedCursor, eventCount: pageEvents.length })); return; }
      for (const event of pageEvents) {
        const resolved = await settleResolvedConflictQueue(tx, key, event, maxRecordBytes);
        await settleConflictPullIssue(tx, key, event, resolved);
        await markQueuePullEchoApplied(tx, key, event.operationId, maxRecordBytes);
        const completed = { ...event, state: 'page_complete' };
        tx.objectStore(STORES.pullEvents).put(completed); putPullTerminalFacts(tx, key, completed);
        if (event.intentId) { const intents = tx.objectStore(STORES.intents);
          const intent = await requestValue(intents.get([key, event.intentId as string])) as IntentRecord | undefined;
          if (intent) intents.put({ ...intent, state: 'page_complete', apiPhase: 'page_complete' }); } }
      for (const write of planned.writes) {
        if (write.kind === 'delete') mappings.delete([key, write.nativeId]);
        else mappings.put(write.mapping);
      }
      for (const event of pageEvents) {
        const exit = event.pendingRangeExit as {
          readonly observation?: UnknownRecord; readonly exclusion?: UnknownRecord;
          readonly exclusions?: UnknownRecord[]; readonly command?: UnknownRecord;
          readonly unbindNativeIds?: string[]; readonly mountBindings?: UnknownRecord[];
        } | undefined;
        const observationStore = tx.objectStore(STORES.remoteObservations);
        for (const raw of [...((event.pendingObservations as UnknownRecord[]) ?? []),
          ...(exit?.observation ? [exit.observation] : [])]) {
          const row = validateRemoteObservation(key, raw, maxRecordBytes);
          const prior = await requestValue(observationStore.get([key, row.colpId])) as RemoteObservationRecord | undefined;
          observationStore.put(mergeRemoteObservation(prior, row));
        }
        if (!exit) continue;
        for (const row of uniqueExclusions([
          ...(exit.exclusion ? [exit.exclusion] : []), ...(exit.exclusions ?? []),
        ].map((raw) => validateLocalSyncExclusion(key, raw, maxRecordBytes)))) {
          tx.objectStore(STORES.localSyncExclusions).put(row);
        }
        if (exit.command) {
          tx.objectStore(STORES.scopeCommandPlans).put(validateScopeCommandPlan(key, exit.command, maxRecordBytes));
        }
        for (const row of exit.mountBindings ?? []) {
          tx.objectStore(STORES.mounts).put(validateMountBinding(key, row, maxRecordBytes));
        }
      }
      if (detachedEventId) return;
      pages.put({ ...page, state: 'page_complete', completedAt: Date.now() });
      tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: page.nextCursor, checkpoint: page.collectionRevision,
        evidence: { pullPageId: page.pageId, pageDigest: page.pageDigest } });
      const rootRebindings = !planned.blocked ? planned.rootRebindings : new Map<string, string>();
      scopes.put({ ...current,
        selectedRoots: current.selectedRoots.map(id => rootRebindings.get(id) ?? id),
        ...(current.privateRoots ? { privateRoots: current.privateRoots.map(id => rootRebindings.get(id) ?? id) } : {}),
        checkpoint: { cursor: String(page.nextCursor), serverRevision: String(page.collectionRevision) } });
    });
    if (blocked) throw new SyncStateError('recovery_required');
  }

  async function commitApplyIntent(input: SyncScope, intentId: string, update: { readonly mapping: MappingInput;
    readonly cursor: { readonly cursor: string; readonly checkpoint: string; readonly evidence: { readonly receiptId: string;
      readonly operationDigest: string } } }, faults: FaultOptions = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(intentId, 'intentId');
    const mapping = validateMapping(key, update.mapping, maxRecordBytes); const cursor = validateCursor(key, update.cursor, maxRecordBytes);
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.receipts, STORES.intents, STORES.mappings, STORES.cursors],
      'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const intents = tx.objectStore(STORES.intents);
        const intent = await requestValue(intents.get([key, intentId])) as IntentRecord | undefined;
        if (!intent) throw new SyncStateError('intent_not_found');
        if (intent.expected.nativeId !== mapping.nativeId) throw new SyncStateError('intent_mapping_mismatch');
        const receipt = await requestValue(tx.objectStore(STORES.receipts).get([key, cursor.evidence.receiptId])) as ReceiptRecord | undefined;
        if (!receipt || receipt.operationDigest !== cursor.evidence.operationDigest) throw new SyncStateError('cursor_evidence_unbound');
        tx.objectStore(STORES.mappings).put(mapping); inject(faults.fault, 'after_mapping', tx);
        tx.objectStore(STORES.cursors).put(cursor); intents.delete([key, intentId]);
      });
  }

  async function putEffectDownload(input: SyncScope, record: EffectPageDownloadRecord): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.diagnostics).put({
        id: `effect-download:${key}:${record.effectId}`, scopeKey: key, kind: 'effect_page_download',
        effectId: record.effectId, pageCount: record.pageCount, nextPageNumber: record.nextPageNumber,
        lastDigest: record.lastDigest, remainingBytes: record.remainingBytes,
        remainingMembers: record.remainingMembers, retryNotBefore: record.retryNotBefore, pages: record.pages,
      });
    });
  }

  async function getEffectDownload(input: SyncScope, effectId: string): Promise<EffectPageDownloadRecord | null> {
    const key = scopeKey(validateScope(input));
    const value = await readOne(STORES.diagnostics, `effect-download:${key}:${effectId}`) as UnknownRecord | undefined;
    if (!value || value.kind !== 'effect_page_download') return null;
    return clone({
      effectId: String(value.effectId), pageCount: Number(value.pageCount),
      nextPageNumber: Number(value.nextPageNumber),
      lastDigest: value.lastDigest === null || value.lastDigest === undefined ? null : String(value.lastDigest),
      remainingBytes: Number(value.remainingBytes), remainingMembers: Number(value.remainingMembers),
      retryNotBefore: Number(value.retryNotBefore),
      pages: Array.isArray(value.pages) ? value.pages as JsonValue[] : [],
    });
  }

  async function clearEffectDownload(input: SyncScope, effectId: string): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.diagnostics).delete(`effect-download:${key}:${effectId}`);
    });
  }

  async function putScopeDiagnostic(input: SyncScope, row: { readonly kind: string; readonly code: string;
    readonly nativeId?: string; readonly details?: JsonObject }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.diagnostics).put({
        id: `${boundedString(row.kind, 'diagnosticKind')}:${key}:${boundedString(row.code, 'diagnosticCode')}:${row.nativeId ?? 'none'}`,
        scopeKey: key, kind: boundedString(row.kind, 'diagnosticKind'), code: boundedString(row.code, 'diagnosticCode'),
        ...(row.nativeId === undefined ? {} : { nativeId: boundedString(row.nativeId, 'nativeId') }),
        ...(row.details === undefined ? {} : { details: row.details }),
      });
    });
  }

  async function pruneExpiredCompletedApplyIntents(input: SyncScope, options: {
    readonly limit?: number; readonly after?: { readonly expiresAt: number; readonly intentId: string };
  } = {}): Promise<{ readonly deleted: number; readonly done: boolean; readonly after?: { readonly expiresAt: number; readonly intentId: string } }> {
    assertWritable(); const key = scopeKey(validateScope(input)); const limit = Math.min(32, Math.max(1, options.limit ?? 32));
    const now = Date.now(); const db = await writableDatabase();
    let deleted = 0; let examined = 0; let done = true;
    let cursorAfter = options.after;
    await runTransaction(db, [STORES.intents, STORES.pullEvents], 'readwrite', async (tx) => {
      const range = IDBKeyRange.bound(
        cursorAfter ? [key, 'page_complete', cursorAfter.expiresAt, cursorAfter.intentId] : [key, 'page_complete', 0, ''],
        [key, 'page_complete', now, '\uffff'], Boolean(cursorAfter), false);
      const index = tx.objectStore(STORES.intents).index(INDEXES.intentByCompletedExpiry);
      const events = tx.objectStore(STORES.pullEvents);
      await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(range);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || examined >= limit) { done = !cursor; resolve(); return; }
          const intent = cursor.value as IntentRecord;
          void (async () => {
            examined += 1;
            cursorAfter = { expiresAt: intent.expiresAt, intentId: intent.intentId };
            const event = intent.eventId
              ? await requestValue(events.get([key, intent.eventId])) as UnknownRecord | undefined : undefined;
            if (expiredCompletedIntentCanBeDeleted(intent, event)) { cursor.delete(); deleted += 1; }
            cursor.continue();
          })().catch(reject);
        };
      });
    });
    return done ? { deleted, done } : { deleted, done, after: cursorAfter };
  }

function intentsForNativeTarget(tx: IDBTransaction, key: string, nativeId: string): Promise<IntentRecord[]> {
  const target = boundedString(nativeId, 'nativeId');
  return cursorPage<IntentRecord>(tx.objectStore(STORES.intents).index(INDEXES.intentByNativeTarget),
    IDBKeyRange.bound([key, target, ''], [key, target, '\uffff']), Number.MAX_SAFE_INTEGER);
}

function expiredCompletedIntentCanBeDeleted(intent: IntentRecord, event: UnknownRecord | undefined): boolean {
  if (intent.state !== 'page_complete' || intent.expiresAt > Date.now()) return false;
  if (intent.repairJobId || intent.waitReason || intent.nativeWaitDecision) return false;
  if (intent.nativeResult === 'unknown' || intent.nativeResult === 'result_unknown') return false;
  if ((intent.replayState === 'unknown' || intent.replayState === 'started' || intent.replayState === 'awaiting_receipt')
      && intent.nativeResult !== 'applied_with_evidence' && intent.nativeResult !== 'absent'
      && intent.nativeResult !== 'failed') return false;
  if (!event) return true;
  if (String(event.state) !== 'page_complete' || pullDeferral(event)) return false;
  return pullEventCallFact(event, intent) === 'known';
}

  return { getApplyIntent, createApplyIntent, findApplyIntent, hasActiveApplyIntentForNativeTarget,
    pruneExpiredCompletedApplyIntents,
    stagePullPage, listPullEvents, listPullEventsByPage, hasPullEventsAwaitingConfirmation, getPullEvent,
    listPullPages, loadPullApplyWorkset, prunePullHistory, pullOperationsCovered, getCursor,
    preparePullIntent, markPullBrowserCallStarted, observeApplyIntentEvent,
    observeApplyIntentPostState, observeApplyIntentChangeFields,
    recordPullApiEvidence, commitPullEvent, completePullPage,
    completeDetachedPullEvent: (scope: SyncScope, pageId: string, eventId: string) => completePullPage(scope, pageId, eventId), commitApplyIntent,
    putEffectDownload, getEffectDownload, clearEffectDownload, putScopeDiagnostic,
    ...createProjectionRepository(ctx) };
}
