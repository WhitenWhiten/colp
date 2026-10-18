import { ISSUE_DEPENDENCY_STORES, transactionIssueDependencies } from './issue-dependencies.js';
import { claimIngressDiagnosticSource } from './ingress-diagnostic-source.js';
import { bootstrapCreateIdentity } from './bootstrap-create-identity.js';
import { enqueueParentIds, enqueueTargetId, findBlockingUnsettledAttempt,
  hasPendingMove } from './queue-live-work.js';
import { PARK_MARKER_PREFIX } from '../bookmark-event-quarantine.js';
import {
  SyncStateError, type BookmarkEventInput, type BookmarkEventParkMarker, type BookmarkEventRecord,
  type CommitBookmarkEventInput, type DurableSyncEngineState, type FaultOptions, type JsonObject, type MappingInput,
  type IntentRecord, type QueueOperation, type SyncScope,
} from './types.js';
import { boundedString, clone, replaceLocalToken, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { constraintError, inject } from './errors.js';
import { cursorPage, iterateCursor, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { holdIfWaiting } from './queue-hold.js';
import { INDEXES, PARKED_DIAGNOSTIC, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateMapping } from './mapping-repository.js';
import { validateQueueInput, validateQueueRecord } from './queue-validate.js';
import {
  COMPACTION_BATCH, compactScopeTransaction, type CompactFault, type CompactReport,
} from '../sync-compaction.js';
import type { SyncStoreRuntime } from './runtime.js';
/**
 * SR-10: the largest ingress ledger `listIngressDiagnostics` serves in one call.
 *
 * The ledger keeps one row per `(scopeKey, code)` under the primary key
 * `ingress:${scopeKey}:${code}`, but that key space is *not* bounded: every
 * quarantined or once-failed inbox event contributes a `park:${eventId}` marker
 * (see `PARK_MARKER_PREFIX`) that is never deleted, so a scope can hold
 * thousands of rows that are not filtered bookmarks at all. The budget is orders
 * of magnitude past any ledger a working profile produces — real codes are a
 * closed vocabulary of ten today, and a marker exists per inbox event that ever
 * failed a prepare round — so it bounds this read's memory without ever trimming
 * an answer a user could act on.
 *
 * A ledger past it is an anomaly and is raised as
 * `ingress_diagnostic_scan_exceeded`, never returned as a short list. The list is
 * the evidence a user reads to understand what sync filtered, so an incomplete
 * list that looks complete is the one outcome this read must not produce. The
 * failure is observable at both call sites: the options worker answers
 * `state_unavailable`, and the quarantine/flush round rejects while the inbox
 * events stay durably staged for the next attempt.
 *
 * Exported so the storage tests pin the boundary.
 */
export const INGRESS_DIAGNOSTIC_SCAN_LIMIT = 20_000;
export function validateBookmarkEventInput(input: unknown, maxBytes: number): BookmarkEventInput {
  const value = strictObject(clone(input), ['eventId', 'dedupeKey', 'occurredAt', 'kind', 'nativeId', 'details'],
    'bookmark event');
  if (!['create', 'change', 'move', 'remove'].includes(String(value.kind))) throw new SyncStateError('bookmark_event_kind_invalid');
  const record: BookmarkEventInput = { eventId: boundedString(value.eventId, 'eventId'),
    dedupeKey: boundedString(value.dedupeKey, 'dedupeKey'),
    occurredAt: boundedString(value.occurredAt, 'occurredAt'), kind: value.kind as BookmarkEventInput['kind'],
    nativeId: boundedString(value.nativeId, 'nativeId'), details: validateJson(value.details, 'event.details') as JsonObject };
  validateRecord(record, maxBytes); return record;
}
export function validateBookmarkEventRecord(input: unknown, maxBytes: number): BookmarkEventRecord {
  const value = strictObject(clone(input), ['scopeKey', 'ordinal', 'status', 'eventId', 'dedupeKey', 'opId',
    'occurredAt', 'kind', 'nativeId', 'details'], 'bookmark event record');
  if (!['pending', 'processed'].includes(String(value.status))) throw new SyncStateError('bookmark_event_status_invalid');
  const event = validateBookmarkEventInput(Object.fromEntries(['eventId', 'dedupeKey', 'occurredAt', 'kind',
    'nativeId', 'details'].map((field) => [field, value[field]])), maxBytes);
  const status = value.status as BookmarkEventRecord['status'];
  const opId = value.opId === null ? null : boundedString(value.opId, 'opId');
  if ((status === 'pending' && opId !== null) || (status === 'processed' && opId === null)) {
    throw new SyncStateError('bookmark_event_operation_state_invalid');
  }
  const record: BookmarkEventRecord = { ...event, scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384),
    ordinal: safeInteger(value.ordinal, 'bookmark event ordinal', 1), status, opId };
  validateRecord(record, maxBytes); return record;
}
export function createBookmarkEventRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function stageBookmarkEvent(input: SyncScope, eventInput: BookmarkEventInput): Promise<{
    readonly outcome: 'staged' | 'duplicate'; readonly event: BookmarkEventRecord }> {
    assertWritable(); const key = scopeKey(validateScope(input)); const event = validateBookmarkEventInput(eventInput, maxRecordBytes);
    const db = await writableDatabase(); let result!: { outcome: 'staged' | 'duplicate'; event: BookmarkEventRecord };
    try { await runTransaction(db, [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.metadata, STORES.bookmarkEvents], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const events = tx.objectStore(STORES.bookmarkEvents);
      const duplicate = await requestValue(events.index(INDEXES.eventByDedupe).get([key, event.dedupeKey])) as
        BookmarkEventRecord | undefined;
      if (duplicate) { result = { outcome: 'duplicate', event: validateBookmarkEventRecord(duplicate, maxRecordBytes) }; return; }
      const counterKey = `bookmark-event-ordinal:${key}`; const metadata = tx.objectStore(STORES.metadata);
      const counter = await requestValue(metadata.get(counterKey)) as { key: string; next: number } | undefined;
      const ordinal = safeInteger(counter?.next ?? 1, 'bookmark event ordinal', 1);
      if (ordinal === Number.MAX_SAFE_INTEGER) throw new SyncStateError('bookmark_event_ordinal_exhausted');
      metadata.put({ key: counterKey, next: ordinal + 1 });
      const record = validateBookmarkEventRecord({ ...event, scopeKey: key, ordinal, status: 'pending', opId: null }, maxRecordBytes);
      events.add(record); result = { outcome: 'staged', event: record };
    }); } catch (error) { throw constraintError(error); }
    return clone(result);
  }

  async function listBookmarkEvents(input: SyncScope, afterOrdinal = 0, limit = 100): Promise<BookmarkEventRecord[]> {
    const key = scopeKey(validateScope(input)); safeInteger(afterOrdinal, 'afterOrdinal'); safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
    const db = await open(); const tx = db.transaction(STORES.bookmarkEvents, 'readonly'); const completion = transactionDone(tx);
    const range = IDBKeyRange.bound([key, afterOrdinal + 1], [key, Number.MAX_SAFE_INTEGER]);
    const values = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
      .index(INDEXES.eventByOrdinal), range, limit); await completion;
    return values.map((value) => clone(validateBookmarkEventRecord(value, maxRecordBytes)));
  }

  async function listBookmarkEventsByStatus(
    input: SyncScope, status: BookmarkEventRecord['status'], afterOrdinal = 0, limit = 100,
  ): Promise<BookmarkEventRecord[]> {
    const key = scopeKey(validateScope(input)); safeInteger(afterOrdinal, 'afterOrdinal'); safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
    const db = await open(); const tx = db.transaction(STORES.bookmarkEvents, 'readonly'); const completion = transactionDone(tx);
    const range = IDBKeyRange.bound([key, status, afterOrdinal + 1], [key, status, Number.MAX_SAFE_INTEGER]);
    const values = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
      .index(INDEXES.eventByStatusOrdinal), range, limit); await completion;
    return values.map((value) => clone(validateBookmarkEventRecord(value, maxRecordBytes)));
  }

  async function listBookmarkEventsByNative(
    input: SyncScope, nativeId: string, afterOrdinal = 0, limit = 100,
  ): Promise<BookmarkEventRecord[]> {
    const key = scopeKey(validateScope(input)); boundedString(nativeId, 'nativeId');
    safeInteger(afterOrdinal, 'afterOrdinal'); safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
    const db = await open(); const tx = db.transaction(STORES.bookmarkEvents, 'readonly');
    const completion = transactionDone(tx);
    const range = IDBKeyRange.bound([key, nativeId, afterOrdinal + 1], [key, nativeId, Number.MAX_SAFE_INTEGER]);
    const values = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
      .index(INDEXES.eventByNativeId), range, limit); await completion;
    return values.map((value) => clone(validateBookmarkEventRecord(value, maxRecordBytes)));
  }

  async function listBookmarkEventsByOperation(
    input: SyncScope, opId: string, afterOrdinal = 0, limit = 100,
  ): Promise<BookmarkEventRecord[]> {
    const key = scopeKey(validateScope(input)); boundedString(opId, 'opId');
    safeInteger(afterOrdinal, 'afterOrdinal'); safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
    const db = await open(); const tx = db.transaction(STORES.bookmarkEvents, 'readonly');
    const completion = transactionDone(tx);
    const range = IDBKeyRange.bound([key, opId, afterOrdinal + 1], [key, opId, Number.MAX_SAFE_INTEGER]);
    const values = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
      .index(INDEXES.eventByOperationOrdinal), range, limit); await completion;
    return values.map(value => clone(validateBookmarkEventRecord(value, maxRecordBytes)));
  }

  /** A remote subtree delete records each native member it actually removed.
   * A delayed Chrome onRemoved callback for that member is a Pull echo, even
   * when its parent/index correlation no longer matches the root intent. */
  async function discardAppliedRemoteDeleteEcho(input: SyncScope, nativeId: string,
    eventId?: string): Promise<boolean> {
    const key = scopeKey(validateScope(input));
    const target = boundedString(nativeId, 'nativeId');
    const db = await writableDatabase();
    let matched = false;
    await runTransaction(db, [STORES.intents, STORES.bookmarkEvents], 'readwrite', async (tx) => {
      await iterateCursor(tx.objectStore(STORES.intents), scopeRowsRange(key), (raw) => {
        const intent = raw as IntentRecord;
        if (intent.liveWorkKind !== 'delete' || !intent.anchors) return;
        const members = intent.anchors.deleteMemberSet;
        const results = intent.anchors.deleteMemberResults;
        if (!Array.isArray(members) || !results || typeof results !== 'object' || Array.isArray(results)) return;
        matched = members.some((member) => member && typeof member === 'object' && !Array.isArray(member)
          && member.nativeId === target && typeof member.colpId === 'string'
          && results[member.colpId] === 'applied');
        if (matched) return false;
      });
      if (!matched || eventId === undefined) return;
      const events = tx.objectStore(STORES.bookmarkEvents);
      const event = await requestValue(events.get([key, boundedString(eventId, 'eventId')])) as BookmarkEventRecord | undefined;
      if (!event || event.status !== 'pending' || event.kind !== 'remove' || event.nativeId !== target) {
        matched = false;
        return;
      }
      events.delete([key, eventId]);
    });
    return matched;
  }

  async function getBookmarkEvent(input: SyncScope, eventId: string): Promise<BookmarkEventRecord | null> {
    const key = scopeKey(validateScope(input)); boundedString(eventId, 'eventId');
    const db = await open(); const tx = db.transaction(STORES.bookmarkEvents, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.bookmarkEvents).get([key, eventId])); await completion;
    return value ? clone(validateBookmarkEventRecord(value, maxRecordBytes)) : null;
  }

  async function compactScope(input: SyncScope, options: {
    readonly batch?: number; readonly now?: number; readonly fault?: CompactFault;
  } = {}): Promise<CompactReport> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const batch = safeInteger(options.batch ?? COMPACTION_BATCH, 'batch', 1);
    if (batch > COMPACTION_BATCH) throw new SyncStateError('limit_exceeded');
    const db = await writableDatabase();
    let report!: CompactReport;
    try {
      await runTransaction(db, [
        STORES.scopes, STORES.queue, STORES.receipts, STORES.cursors, STORES.bookmarkEvents,
        STORES.compactionWatermarks, STORES.compactSummaries,
      ], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        report = await compactScopeTransaction(tx, {
          scopeKey: key, batch, now: options.now ?? Date.now(), fault: options.fault,
          stores: {
            queue: STORES.queue, receipts: STORES.receipts, cursors: STORES.cursors,
            events: STORES.bookmarkEvents, watermarks: STORES.compactionWatermarks,
            summaries: STORES.compactSummaries,
          },
          indexes: {
            queueByStatus: INDEXES.queueByStatusSequence, queueByOpId: INDEXES.queueByOpId,
            eventByStatus: INDEXES.eventByStatusOrdinal,
          },
        });
      });
    } catch (error: unknown) {
      if (error instanceof Error && (error.message === 'fault_injected' || (error as { code?: string }).code === 'fault_injected')) {
        throw new SyncStateError('fault_injected');
      }
      throw constraintError(error);
    }
    return clone(report);
  }

  async function commitBookmarkEvent(input: SyncScope, eventId: string, commitInput: CommitBookmarkEventInput,
    faults: FaultOptions = {}): Promise<QueueOperation> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(eventId, 'eventId');
    if (typeof commitInput.validateOperation !== 'function' || typeof commitInput.digestOperation !== 'function'
      || typeof commitInput.allocateOperationId !== 'function') {
      throw new SyncStateError('operation_validator_missing');
    }
    const operationTemplate = validateJson(clone(commitInput.operation), 'operation') as JsonObject;
    const mappingTemplate = commitInput.mapping ? clone(commitInput.mapping) : undefined;
    const deleteNativeIds = [...new Set((commitInput.deleteNativeIds ?? []).map((id) => boundedString(id, 'nativeId')))];
    const db = await writableDatabase(); let committed!: QueueOperation;
    const hold: { current?: { readonly eventId: string; readonly nativeId: string;
      readonly blocker: QueueOperation } } = {};
    // Atomic authority order: durable_sequences -> outbound_queue -> bookmark_events -> native_mappings.
    try { await runTransaction(db, [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.sequences, STORES.queue, STORES.bookmarkEvents,
      STORES.mappings, STORES.engine, STORES.bootstrapRuns, STORES.receipts, STORES.remoteObservations], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const events = tx.objectStore(STORES.bookmarkEvents);
      const event = await requestValue(events.get([key, eventId])) as BookmarkEventRecord | undefined;
      if (!event) throw new SyncStateError('bookmark_event_not_found');
      const validatedEvent = validateBookmarkEventRecord(event, maxRecordBytes);
      const queue = tx.objectStore(STORES.queue);
      if (validatedEvent.status === 'processed') {
        if (!validatedEvent.opId) throw new SyncStateError('bookmark_event_operation_missing');
        const prior = await requestValue(queue.index(INDEXES.queueByOpId).get([key, validatedEvent.opId])) as QueueOperation | undefined;
        if (!prior) throw new SyncStateError('bookmark_event_queue_missing'); committed = validateQueueRecord(prior, maxRecordBytes); return;
      }
      const engine = await requestValue(tx.objectStore(STORES.engine).get(key)) as DurableSyncEngineState | undefined;
      if (engine?.recoveryFrozen) throw new SyncStateError('queue_recovery_frozen');
      const sharedCreate = await bootstrapCreateIdentity(tx, key, validatedEvent, operationTemplate, maxRecordBytes);
      if (sharedCreate?.queued) { committed = sharedCreate.queued; return; }
      // F010: only an event that really depends on an unsettled attempt is
      // held — the same canonical target, a parent it writes into, or the same
      // native subtree. Unrelated targets keep ingressing; the held event stays
      // in the inbox and its wait becomes durable evidence below.
      const targetId = enqueueTargetId(operationTemplate);
      const blocker = await findBlockingUnsettledAttempt(queue, key, {
        ...(targetId === undefined ? {} : { targetId }),
        parentIds: enqueueParentIds(operationTemplate),
        nativeIds: [validatedEvent.nativeId, ...deleteNativeIds],
      }, tx.objectStore(STORES.mappings));
      if (blocker) {
        hold.current = { eventId, nativeId: validatedEvent.nativeId, blocker };
        throw new SyncStateError('exact_retry_pending');
      }
      // A Pull refresh can make trustedIdentity non-local while an earlier
      // move still awaits a definitive receipt. Keep later moves in the inbox.
      if (operationTemplate.type === 'move_node'
          && await hasPendingMove(queue, key, operationTemplate.targetId)) throw new SyncStateError('move_predecessor_pending');
      const sequences = tx.objectStore(STORES.sequences);
      const counter = await requestValue(sequences.get(key)) as { scopeKey: string; next: number } | undefined;
      if (!counter) throw new SyncStateError('sequence_missing'); const sequence = safeInteger(counter.next, 'sequence', 1);
      if (sequence === Number.MAX_SAFE_INTEGER) throw new SyncStateError('sequence_exhausted');
      const opId = boundedString(sharedCreate?.opId ?? commitInput.allocateOperationId(), 'opId');
      const operationResolved = replaceLocalToken(operationTemplate, validatedEvent.eventId, opId) as JsonObject;
      const operation = { ...operationResolved, opId, replicaId: input.replicaId,
        sequence, collectionId: input.collectionId, occurredAt: validatedEvent.occurredAt } as JsonObject;
      let schemaValid = false;
      try { schemaValid = commitInput.validateOperation(operation); } catch { throw new SyncStateError('operation_schema_invalid'); }
      if (!schemaValid) throw new SyncStateError('operation_schema_invalid');
      const operationBytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength;
      if (operationBytes > Math.min(maxRecordBytes, 64 * 1024)) throw new SyncStateError('operation_byte_budget_exceeded');
      const digest = boundedString(commitInput.digestOperation(operation), 'operation digest');
      const baseRevision = commitInput.baseRevision === null ? null
        : String(replaceLocalToken(commitInput.baseRevision, validatedEvent.eventId, opId));
      const queueInput = validateQueueInput(key, { opId, batchId: opId,
        idempotencyKey: opId, digest, endpointIdentity: 'syncPush',
        mediaType: 'application/json', baseRevision,
        operationRevision: String(replaceLocalToken(commitInput.operationRevision, validatedEvent.eventId, opId)),
        status: 'pending', retry: { attempt: 0, notBefore: 0 },
        payload: operation }, maxRecordBytes);
      sequences.put({ scopeKey: key, next: sequence + 1 }); inject(faults.fault, 'after_sequence', tx);
      committed = await holdIfWaiting(queue, key, { ...queueInput, scopeKey: key, sequence }, maxRecordBytes, validatedEvent.details.hold, validatedEvent.eventId);
      queue.add(committed); inject(faults.fault, 'after_queue', tx);
      const mappings = tx.objectStore(STORES.mappings);
      const mapping = mappingTemplate ? validateMapping(key,
        replaceLocalToken(mappingTemplate, validatedEvent.eventId, opId) as unknown as MappingInput, maxRecordBytes) : undefined;
      if (mapping) mappings.put(mapping);
      for (const nativeId of deleteNativeIds) mappings.delete([key, nativeId]);
      events.put({ ...validatedEvent, status: 'processed', opId }); inject(faults.fault, 'after_event', tx);
    }); } catch (error) {
      if (hold.current) await recordDependencyHold(input, key, hold.current).catch(() => undefined);
      throw constraintError(error);
    }
    durableCache.set(key, { sequence: committed.sequence, opId: committed.opId }); return clone(committed);
  }

  /**
   * F010: durable evidence for an inbox event held by an unsettled attempt. The
   * row is the per-event ingress marker the quarantine loads, so the wait is
   * observable (which queue row blocks it, and for how many rounds) while the
   * event stays in the inbox and resumes on the first flush after that row
   * settles. A hold is never a park: an unsettled attempt always settles.
   */
  async function recordDependencyHold(input: SyncScope, key: string,
    held: { readonly eventId: string; readonly nativeId: string; readonly blocker: QueueOperation }): Promise<void> {
    const code = `${PARK_MARKER_PREFIX}${held.eventId}`;
    const prior = await readOne(STORES.diagnostics, `ingress:${key}:${code}`) as
      { readonly park?: { readonly attempts?: number } } | undefined;
    await putIngressDiagnostic(input, { code, park: { eventId: held.eventId, state: 'open',
      code: 'exact_retry_pending', attempts: safeInteger((prior?.park?.attempts ?? 0) + 1, 'parkAttempts'),
      at: new Date().toISOString(), reason: 'exact_retry_pending',
      dependencyNativeId: held.nativeId, dependencyOpId: held.blocker.opId } });
  }

  /**
   * SR-10: folds one suppressed ingress event into the durable per-`(key, code)`
   * ledger row. The primary key stays `ingress:${key}:${code}`, so a repeated
   * code updates its single row instead of appending an unbounded history:
   * `count` accumulates, `firstAt` keeps the first occurrence and `lastAt`
   * never regresses. `park` is pending state, so a later plain diagnostic of
   * the same code keeps the existing marker instead of erasing it.
   *
   * `now` is injectable; source ids make bootstrap omissions idempotent.
   */
  async function putIngressDiagnostic(input: SyncScope, diagnostic: { readonly code: string;
    readonly park?: BookmarkEventParkMarker }, options: { readonly now?: number; readonly sourceId?: string } = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const code = boundedString(diagnostic.code, 'code', 64);
    const at = safeInteger(options.now ?? Date.now(), 'ingressDiagnosticNow');
    const park = diagnostic.park === undefined ? undefined : validateBookmarkEventPark(diagnostic.park);
    const id = `ingress:${key}:${code}`;
    const db = await writableDatabase();
    await runTransaction(db, [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const diagnostics = tx.objectStore(STORES.diagnostics);
      if (!await claimIngressDiagnosticSource(tx, key, code, options.sourceId)) return;
      const prior = await requestValue(diagnostics.get(id));
      diagnostics.put(mergeIngressDiagnostic(key, code, prior, park, at, maxRecordBytes));
    });
  }

  /**
   * The quarantine park markers for `liveEventIds`, and a durable prune of the
   * markers whose event has left the inbox.
   *
   * Markers are one diagnostic row per parked event, and the queue never drops
   * an event on its own, so a scope that drains its inbox would otherwise keep
   * every marker forever and eventually push the ingress range past
   * `INGRESS_DIAGNOSTIC_SCAN_LIMIT` — at which point every flush rejects and
   * outbound sync stops. A parked event that is still in the inbox keeps its
   * marker; one that is gone is settled history and is removed here.
   *
   * Returns the markers read for the live events, so a caller that already has
   * the event list does not read the range twice.
   */
  async function pruneParkDiagnostics(input: SyncScope,
    liveEventIds: ReadonlySet<string>): Promise<ReadonlyMap<string, BookmarkEventParkMarker>> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase();
    const markers = new Map<string, BookmarkEventParkMarker>();
    const tx = db.transaction([STORES.diagnostics, STORES.metadata], 'readwrite');
    const completion = transactionDone(tx);
    const store = tx.objectStore(STORES.diagnostics);
    // Pre-v17 marker rows carry no discriminator and are therefore not in the
    // index. The upgrade is forbidden from walking history to stamp them, so the
    // first prune adopts them instead — a bounded pass that writes once per
    // legacy marker.
    await adoptLegacyParkMarkers(store, tx.objectStore(STORES.metadata), key, liveEventIds, markers);
    // Only marker rows are in `by_scope_parked`, so this pass costs the markers
    // rather than the ingress ledger they are stored beside. Walking `by_scope`
    // visited every row: 20_000 marker rows cost ~70s that way, and a ledger past
    // the ingress scan budget could not be pruned in bounded time.
    const range = IDBKeyRange.bound([key, PARKED_DIAGNOSTIC], [key, PARKED_DIAGNOSTIC]);
    await iterateCursor(store.index(INDEXES.diagnosticByPark), range, (value, cursor) => {
      if (!value || typeof value !== 'object') return undefined;
      const record = value as { readonly park?: BookmarkEventParkMarker };
      if (record.park === undefined) return undefined;
      if (liveEventIds.has(record.park.eventId)) markers.set(record.park.eventId, record.park);
      else cursor.delete();
      return undefined;
    });
    await completion;
    return markers;
  }

  async function listIngressDiagnostics(input: SyncScope): Promise<readonly IngressDiagnosticRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    // SR-10: the whole `ingress:${key}:*` range is read, not one fixed cursor
    // window. The range is shared with the unbounded `park:${eventId}` markers,
    // so a window over it is a window over the *markers*: a scope with more
    // markers than the window used to push real codes out of the answer and
    // under-report silently. `getAll` reads the range in a single request and is
    // the reason the whole range is affordable — a cursor walks it row by row
    // (20_001 rows cost ~190s in the host test environment against ~0.1s here,
    // and ~0.5s for a 1_000-row window), and `cursorPage` exposes neither the
    // last key nor the range's upper bound, so a resumable loop would add idb.ts
    // API surface to buy back a cost this call does not have to pay. `limit + 1`
    // is the usual "one more than the budget proves there is more" probe; it
    // makes truncation an explicit error instead of a short list.
    const range = IDBKeyRange.bound([key, `ingress:${key}:`], [key, `ingress:${key}:\uffff`]);
    const values = await requestValue<unknown[]>(tx.objectStore(STORES.diagnostics)
      .index(INDEXES.diagnosticByScope).getAll(range, INGRESS_DIAGNOSTIC_SCAN_LIMIT + 1));
    await completion;
    if (values.length > INGRESS_DIAGNOSTIC_SCAN_LIMIT) throw new SyncStateError('ingress_diagnostic_scan_exceeded');
    // SR-10: the `diagnosticByScope` index orders by id, i.e. alphabetically by
    // code, so the most recent suppression must be sorted to the front here.
    // Sorting never drops a row: the whole range was read above, and the id per
    // code is stable, so there is at most one row per code. `code` breaks ties so
    // a fixed clock still yields a deterministic order.
    return values.filter((value) => value && typeof value === 'object' && (value as { kind?: string }).kind === 'ingress')
      .map((value) => clone(validateIngressDiagnostic(key, value, maxRecordBytes)))
      .sort((left, right) => (right.lastAt - left.lastAt) || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  }

  return { stageBookmarkEvent, listBookmarkEvents, listBookmarkEventsByStatus, listBookmarkEventsByNative,
    listBookmarkEventsByOperation,
    getBookmarkEvent, discardAppliedRemoteDeleteEcho, compactScope, commitBookmarkEvent,
    putIngressDiagnostic, listIngressDiagnostics,
    pruneParkDiagnostics };
}

/**
 * SR-10: one durable ledger row per `(scopeKey, code)`, the storage contract the
 * options UI reads. `id` stays `ingress:${scopeKey}:${code}` so the primary key
 * is stable and one code can never fan out into an unbounded number of rows.
 * `count` is the number of suppressed events seen for the code, `firstAt` and
 * `lastAt` are epoch milliseconds of the first and most recent suppression, and
 * `park` is the optional quarantine marker — a pending state a later plain
 * diagnostic of the same code must not clear.
 */
export type IngressDiagnosticRecord = { readonly id: string; readonly scopeKey: string; readonly kind: 'ingress';
  readonly code: string; readonly count: number; readonly firstAt: number; readonly lastAt: number;
  readonly park?: BookmarkEventParkMarker;
  /** Index discriminator for `by_scope_parked`; present exactly when `park` is. */
  readonly parked?: typeof PARKED_DIAGNOSTIC };

/**
 * Stamps `parked` onto pre-v17 marker rows, or removes those whose event has
 * left the inbox.
 *
 * Bounded by {@link LEGACY_PARK_ADOPTION_LIMIT} and a no-op for any row that
 * already carries the discriminator, so it costs the ledger once per scope
 * rather than once per flush. Without it a pre-v17 marker is invisible to
 * `by_scope_parked` and would stay on disk forever.
 */
const LEGACY_PARK_ADOPTION_LIMIT = 4_096;
/**
 * Adoption runs at most once per scope, and its bound counts ADOPTED markers
 * rather than visited rows.
 *
 * Both details are load-bearing. Counting visited rows made the bound
 * unreachable: on a scope with more than 4,096 ledger rows the pass stopped
 * before reaching the legacy markers behind them, every time, so those markers
 * were never adopted, never pruned and never returned to the quarantine — they
 * were stranded. And re-running it on every prune re-walked up to 4,096 rows per
 * flush for nothing (measured: 20,050 markerless rows cost ~10.7s on the first
 * prune and ~24s on the second). A scope is recorded as done once a pass
 * completes; any later v17 write stamps `parked` itself, so nothing new can
 * appear unstamped.
 */
function legacyAdoptionKey(key: string): string { return `park-adoption:${key}`; }

/** Bumped when a completion marker's meaning changes, so stale ones are redone. */
const LEGACY_ADOPTION_VERSION = 2;

async function adoptLegacyParkMarkers(store: IDBObjectStore, metadata: IDBObjectStore, key: string,
  liveEventIds: ReadonlySet<string>, markers: Map<string, BookmarkEventParkMarker>): Promise<void> {
  // Adoption is per SCOPE, and so is the marker that decides it.
  //
  // This used to gate on the database-global `park-adoption-pending` flag and
  // delete it on the first completed sweep, which stranded every other scope: the
  // first scope to prune cleared the flag, so no later scope ever adopted or
  // pruned its own pre-v17 markers. The flag is now only an "an in-place upgrade
  // happened" signal, and each scope marks its own completion.
  const doneKey = legacyAdoptionKey(key);
  const done = await requestValue(metadata.get(doneKey)) as
    { readonly key?: string; readonly adopted?: number; readonly v?: number } | undefined;
  // A marker from the build that recorded `adopted: 0` from an ABSENT flag is not a
  // completion — the sweep never ran for that scope, so its pre-v17 markers are
  // still unstamped and stranded. Those records carry no `v`, so they are treated
  // as incomplete and swept once more; every completion written from here records
  // `v: 2` and is honoured, so the extra pass happens exactly once per scope and a
  // genuinely marker-free scope is never re-walked.
  if (done !== undefined && done.v === LEGACY_ADOPTION_VERSION) return;
  // An ABSENT flag is not evidence that there is nothing to adopt, and must not be
  // treated as a completion. `e81297ba3` deleted `park-adoption-pending` when the
  // first scope finished, so a database written by that build has no flag while
  // other scopes still hold unstamped pre-v17 markers. Recording a permanent
  // `adopted: 0` here stranded those rows forever — the sweep would never look
  // again. The flag is a hint that an in-place upgrade happened; the DONE marker,
  // written only after a real pass, is what records completion. So an absent flag
  // runs the bounded pass anyway: it is one walk per scope, once ever, because a
  // completed pass writes the done marker.
  // ONLY the park-code range, not the whole ingress ledger. Every park marker's id
  // is `ingress:<scope>:park:<eventId>`, so `by_scope` can be ranged to those rows
  // alone. Walking `ingress:<scope>:` to `\uffff` instead — which this did first —
  // means paying a scan proportional to the WHOLE ledger (measured at ~70s on
  // 20,000 markerless rows) merely to find a handful of markers, and that cost is
  // what made the unarmed walk unacceptable. Narrowed, the sweep is proportional to
  // markers, so it is safe to run whenever a scope has no completion marker rather
  // than treating an absent upgrade flag as proof that there is nothing to adopt —
  // the mistake that stranded markers left behind by earlier builds.
  const range = IDBKeyRange.bound(
    [key, `ingress:${key}:${PARK_MARKER_PREFIX}`],
    [key, `ingress:${key}:${PARK_MARKER_PREFIX}\uffff`]);
  let adopted = 0;
  let truncated = false;
  await iterateCursor(store.index(INDEXES.diagnosticByScope), range, (value, cursor) => {
    if (adopted >= LEGACY_PARK_ADOPTION_LIMIT) { truncated = true; return false; }
    if (!value || typeof value !== 'object') return undefined;
    const record = value as { readonly park?: BookmarkEventParkMarker; readonly parked?: unknown };
    if (record.park === undefined || record.parked !== undefined) return undefined;
    adopted += 1;
    if (liveEventIds.has(record.park.eventId)) {
      markers.set(record.park.eventId, record.park);
      cursor.update({ ...(value as object), parked: PARKED_DIAGNOSTIC });
    } else cursor.delete();
    return undefined;
  });
  // A truncated pass leaves the scope unmarked so the next prune resumes; a
  // completed one is recorded and never walked again.
  if (!truncated) metadata.put({ key: doneKey, adopted, at: Date.now(), v: LEGACY_ADOPTION_VERSION });
}

function validateIngressDiagnostic(key: string, input: unknown, maxBytes: number): IngressDiagnosticRecord {
  const value = strictObject(clone(input), ['id', 'scopeKey', 'kind', 'code', 'count', 'firstAt', 'lastAt',
    'park', 'parked'], 'ingress diagnostic', ['count', 'firstAt', 'lastAt', 'park', 'parked']);
  if (value.kind !== 'ingress' || value.scopeKey !== key) throw new SyncStateError('ingress_diagnostic_invalid');
  // SR-10 upgrade tolerance: rows written before the ledger existed carry none
  // of count/firstAt/lastAt. They are read as a single suppression at epoch 0
  // instead of being rejected, so an upgraded profile keeps listing its
  // diagnostics and the next write for that code simply continues the count.
  const firstAt = value.firstAt === undefined ? undefined : safeInteger(value.firstAt, 'ingressDiagnosticFirstAt');
  const lastAt = value.lastAt === undefined ? firstAt ?? 0 : safeInteger(value.lastAt, 'ingressDiagnosticLastAt');
  const normalizedFirstAt = firstAt ?? lastAt;
  if (normalizedFirstAt > lastAt) throw new SyncStateError('ingress_diagnostic_invalid');
  const record: IngressDiagnosticRecord = { id: boundedString(value.id, 'id', 16_384),
    scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384), kind: 'ingress',
    code: boundedString(value.code, 'code', 64),
    count: value.count === undefined ? 1 : safeInteger(value.count, 'ingressDiagnosticCount', 1),
    firstAt: normalizedFirstAt, lastAt,
    // Derived from the marker, never trusted from the input: it is the index key
    // for `by_scope_parked`, so a row claiming it without a marker would be
    // pruned as an orphan.
    ...(value.park === undefined ? {} : { park: validateBookmarkEventPark(value.park),
      parked: PARKED_DIAGNOSTIC }) };
  validateRecord(record, maxBytes); return record;
}

/**
 * SR-10: one suppressed event folded into the existing ledger row. A prior row
 * that cannot be read as a diagnostic (corruption) restarts the ledger instead
 * of failing the write: this path is awaited by capture, and a bad diagnostic
 * row must never wedge ingress.
 */
function mergeIngressDiagnostic(key: string, code: string, priorInput: unknown, park: BookmarkEventParkMarker | undefined,
  at: number, maxBytes: number): IngressDiagnosticRecord {
  let prior: IngressDiagnosticRecord | undefined;
  try { prior = priorInput === undefined ? undefined : validateIngressDiagnostic(key, priorInput, maxBytes); }
  catch { prior = undefined; }
  // The marker is retained because a park is an unresolved state; only a newer
  // marker of the same code replaces it.
  const retainedPark = park ?? prior?.park;
  const record: IngressDiagnosticRecord = { id: `ingress:${key}:${code}`, scopeKey: key, kind: 'ingress', code,
    // Saturates instead of throwing: the ledger is observability, and a counter
    // at the safe-integer ceiling must not start failing capture writes.
    count: prior === undefined ? 1 : Math.min(prior.count + 1, Number.MAX_SAFE_INTEGER),
    firstAt: prior?.firstAt ?? at,
    // A clock that moves backwards must not make `lastAt` claim the most recent
    // occurrence predates the first one.
    lastAt: Math.max(prior?.lastAt ?? at, at),
    ...(retainedPark === undefined ? {} : { park: retainedPark, parked: PARKED_DIAGNOSTIC }) };
  validateRecord(record, maxBytes); return record;
}

export function validateBookmarkEventPark(input: unknown): BookmarkEventParkMarker {
  const value = strictObject(clone(input), ['eventId', 'state', 'code', 'attempts', 'at', 'reason',
    'dependencyNativeId', 'dependencyOpId', 'dependencyEventId', 'dependencyStamp'], 'bookmark event park',
  ['reason', 'dependencyNativeId', 'dependencyOpId', 'dependencyEventId', 'dependencyStamp']);
  if (value.state !== 'open' && value.state !== 'parked') throw new SyncStateError('bookmark_event_park_state_invalid');
  return { eventId: boundedString(value.eventId, 'parkEventId'), state: value.state,
    code: boundedString(value.code, 'parkCode', 64), attempts: safeInteger(value.attempts, 'parkAttempts'),
    at: boundedString(value.at, 'parkAt'),
    ...(value.reason === undefined ? {} : { reason: boundedString(value.reason, 'parkReason', 64) }),
    ...(value.dependencyNativeId === undefined ? {} : {
      dependencyNativeId: boundedString(value.dependencyNativeId, 'parkDependencyNativeId') }),
    ...(value.dependencyOpId === undefined ? {} : {
      dependencyOpId: boundedString(value.dependencyOpId, 'parkDependencyOpId') }),
    ...(value.dependencyEventId === undefined ? {} : {
      dependencyEventId: boundedString(value.dependencyEventId, 'parkDependencyEventId') }),
    ...(value.dependencyStamp === undefined ? {} : {
      dependencyStamp: boundedString(value.dependencyStamp, 'parkDependencyStamp') }) };
}
