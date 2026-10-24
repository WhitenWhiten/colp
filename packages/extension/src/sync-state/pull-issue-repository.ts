import { openIngressIssue, mergeLocalIssues } from './open-issue-facts.js';
import { boundedString, clone, safeInteger } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { validateMapping } from './mapping-repository.js';
import { putPullTerminalFacts } from './pull-workset.js';
import { createPullItemRetryRepository } from './pull-item-retry-repository.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type MappingInput, type SyncScope, type UnknownRecord, type BookmarkEventRecord } from './types.js';

/** A remote node this browser could not take in. Its events retain the reason native application was skipped or rejected. */
export interface PullIssueRecord {
  readonly nodeId: string;
  readonly code: string;
  readonly eventId: string;
  /** A conflict decision carrying this node's full state can settle this derived hold. */
  readonly conflictOpIds?: readonly string[];
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/** A browser bookmark change that could not be tied to the library and was not synced. */
export interface LocalIssueRecord {
  readonly eventId?: string;
  readonly dependencyOpId?: string;
  readonly dependencyEventId?: string;
  readonly dependencyNativeId?: string;
  readonly rootCause?: string;
  readonly attempts?: number;
  readonly recovery?: 'automatic' | 'decision';
  readonly nativeId: string;
  readonly code: string;
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/** The title is often the problem itself (too long to store), so the row keeps only its start. */
export const PULL_ISSUE_TITLE_MAX = 200;
const prefix = (key: string) => `pull-issue:${key}:`;
/** The durable row of one set-aside remote item. */
export const pullIssueFactId = (key: string, nodeId: string): string => `${prefix(key)}${nodeId}`;
/** States an event can fail in before its browser call changed anything. */
const SET_ASIDE_STATES = new Set(['staged', 'intent_prepared']);
const localPrefix = (key: string) => `local-issue:${key}:`;

/** Rule B: a node whose change the browser refuses is set aside under `apply_failed:<code>` (the code names the refusal). */
export const APPLY_FAILED_PREFIX = 'apply_failed:';
/** Failures closer together than this are one wake; the engine's backoff between wakes is at least a second. */
export const APPLY_FAILURE_WAKE_GAP_MS = 5_000;
/** A count that has not moved for this long belongs to an earlier, unrelated trouble and starts again at one. */
export const APPLY_FAILURE_STALE_MS = 60 * 60_000;
const applyFailureId = (key: string, subject: string) => `apply-failure:${key}:${subject}`;

/** The effect names exactly one node of this id and touches only that node in the browser. */
function singleNodeEffect(effect: { kind?: string; node?: { id?: string }; tombstone?: { targetId?: string } } | undefined,
  nodeId: string): boolean {
  if (!effect) return false;
  if (effect.kind === 'node_deleted') return effect.tombstone?.targetId === nodeId;
  return ['node_created', 'node_moved', 'node_content_updated'].includes(String(effect.kind)) && effect.node?.id === nodeId;
}

/**
 * B7: an item a Pull page cannot store is set aside, not a reason to stop the
 * page. The event commits with nothing to write, so the page completes and the
 * cursor moves on; the node and why it was set aside stay in a durable row
 * until explicit repair or a replica rebuild clears it.
 */
export function createPullIssueRepository(ctx: SyncStoreRuntime) {
  /** Validates the mapping a Pull event would store, before any browser call. Throws the codec error. */
  function probeMappingRecord(input: SyncScope, mapping: MappingInput): void {
    validateMapping(scopeKey(validateScope(input)), mapping, ctx.maxRecordBytes);
  }

  /**
   * Commits an event without touching the browser and records its node. The
   * event is staged, or failed before its browser call changed anything; its
   * apply intent, if any, settles with it. A remote tombstone does not erase
   * unresolved evidence.
   */
  async function setAsidePullEvent(input: SyncScope, eventId: string, issue: {
    readonly code: string; readonly nodeId: string; readonly title?: string;
    readonly conflictOpIds?: readonly string[];
    /**
     * A typed browser rejection of one call about this one node, never an uncertain create or a subtree mutation:
     * `managed_not_writable` for a single update, `native_call_rejected` (code `apply_failed:*`) for the node's
     * own create, move, delete or update after the engine counted the same refusal on several wakes.
     */
    readonly nativeRejection?: 'managed_not_writable' | 'native_call_rejected';
    readonly now: number;
  }): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const code = boundedString(issue.code, 'recovery code'); const nodeId = boundedString(issue.nodeId, 'nodeId');
    const now = safeInteger(issue.now, 'now');
    const title = issue.title?.trim() ? issue.title.trim().slice(0, PULL_ISSUE_TITLE_MAX) : undefined;
    const conflictOpIds = issue.conflictOpIds?.map(id => boundedString(id, 'conflict operation id'));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.pullEvents, STORES.intents,
      STORES.diagnostics], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, boundedString(eventId, 'eventId')])) as UnknownRecord | undefined;
        const effect = (event?.payload as { effect?: { kind?: string; node?: { id?: string } } } | undefined)?.effect;
        const rejectedUpdate = issue.nativeRejection === 'managed_not_writable' && code === issue.nativeRejection
          && effect?.kind === 'node_content_updated' && effect.node?.id === nodeId;
        const rejectedCall = issue.nativeRejection === 'native_call_rejected' && code.startsWith(APPLY_FAILED_PREFIX)
          && singleNodeEffect(effect, nodeId);
        const startedRejection = rejectedUpdate || rejectedCall;
        if (!event || !(SET_ASIDE_STATES.has(String(event.state)) || startedRejection && event.state === 'browser_call_started')
            || event.apiResultEvidence || event.nativeEventEvidence
            || ['pendingMappings', 'pendingObservations', 'pendingDeleteNativeIds'].some(field =>
              Array.isArray(event[field]) && (event[field] as unknown[]).length > 0)) {
          throw new SyncStateError('pull_event_state_invalid');
        }
        if (typeof event.intentId === 'string') {
          const intents = tx.objectStore(STORES.intents);
          const intent = await requestValue(intents.get([key, event.intentId])) as UnknownRecord | undefined;
          if (intent && (intent.apiResultEvidence || intent.nativeEventEvidence
            || (!startedRejection && (intent.apiPhase === 'browser_call_started' || intent.replayState === 'started'))
            || (rejectedCall && ['result_unknown', 'waiting_dependency'].includes(String(intent.nativeResult)))
            || intent.nativeResult === 'applied_with_evidence' || intent.replayState === 'awaiting_receipt')) {
            throw new SyncStateError('pull_event_state_invalid');
          }
          if (intent) intents.put({ ...intent, state: 'authority_committed', apiPhase: 'authority_committed',
            apiResultEvidence: { setAside: code, ...(startedRejection ? { nativeRejection: issue.nativeRejection } : {}) } });
        }
        const committed = { ...event, state: 'authority_committed', pendingMappings: [], pendingObservations: [],
          pendingDeleteNativeIds: [], apiResultEvidence: { setAside: code, nodeId, ...(startedRejection ? { nativeRejection: issue.nativeRejection } : {}) } };
        events.put(committed); putPullTerminalFacts(tx, key, committed);
        tx.objectStore(STORES.diagnostics).delete(applyFailureId(key, `pull:${String(eventId)}`));
        await putPullIssueFact(tx, key, { code, nodeId, eventId, ...(title ? { title } : {}),
          ...(conflictOpIds?.length ? { conflictOpIds } : {}), now });
      });
  }

  /**
   * Rule B: counts the browser's refusals of one subject (a Pull event, a projection intent), one per wake, so the
   * engine can retry a few times and then set the subject aside instead of failing every wake forever. The row is
   * evidence only: nothing reads it as authority, and a count that went quiet for an hour starts again.
   */
  async function recordApplyFailure(input: SyncScope, failure: {
    readonly subject: string; readonly code: string; readonly detail?: string; readonly now: number;
  }): Promise<{ readonly count: number }> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const subject = boundedString(failure.subject, 'subject'); const code = boundedString(failure.code, 'code');
    const now = safeInteger(failure.now, 'now'); const detail = failure.detail?.trim() ? failure.detail.trim().slice(0, 200) : undefined;
    let count = 1;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const rows = tx.objectStore(STORES.diagnostics); const id = applyFailureId(key, subject);
      const prior = await requestValue(rows.get(id)) as UnknownRecord | undefined;
      const lastSeenAt = typeof prior?.lastSeenAt === 'number' ? prior.lastSeenAt : undefined;
      const continuing = prior?.code === code && lastSeenAt !== undefined && Math.abs(now - lastSeenAt) <= APPLY_FAILURE_STALE_MS;
      const sameWake = continuing && now >= lastSeenAt && now - lastSeenAt < APPLY_FAILURE_WAKE_GAP_MS;
      count = !continuing ? 1 : sameWake ? Number(prior.count) : Number(prior.count) + 1;
      rows.put({ id, scopeKey: key, kind: 'apply_failure', subject, code, count,
        firstSeenAt: continuing ? Number(prior.firstSeenAt) : now, lastSeenAt: sameWake ? lastSeenAt : now,
        ...(detail ? { detail } : {}) });
    });
    return { count };
  }

  async function listPullIssues(input: SyncScope): Promise<PullIssueRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
      pullIssueRange(key), Number.MAX_SAFE_INTEGER);
    await completion;
    return rows.map((row) => clone({ nodeId: String(row.nodeId), code: String(row.code), eventId: String(row.eventId),
      ...(Array.isArray(row.conflictOpIds) ? { conflictOpIds: row.conflictOpIds as string[] } : {}),
      ...(typeof row.title === 'string' ? { title: row.title } : {}), count: Number(row.count),
      firstSeenAt: Number(row.firstSeenAt), lastSeenAt: Number(row.lastSeenAt) }));
  }

  /**
   * Records a browser change that cannot be tied to the library, such as a
   * deletion of a bookmark with no mapping. Nothing is uploaded for it and
   * nothing else stops; the row only reports it.
   */
  async function recordLocalIssue(input: SyncScope, issue: {
    readonly code: string; readonly nativeId: string; readonly title?: string; readonly now: number;
    readonly quarantine?: { readonly rootNativeId: string; readonly evidenceDigest: string };
  }): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const code = boundedString(issue.code, 'recovery code'); const nativeId = boundedString(issue.nativeId, 'nativeId');
    const now = safeInteger(issue.now, 'now');
    const title = issue.title?.trim() ? issue.title.trim().slice(0, PULL_ISSUE_TITLE_MAX) : undefined;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics, STORES.localSyncExclusions], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const rows = tx.objectStore(STORES.diagnostics);
      const id = `${localPrefix(key)}${code}:${nativeId}`;
      const prior = await requestValue(rows.get(id)) as LocalIssueRecord | undefined;
      const shown = prior?.title ?? title;
      rows.put({ id, scopeKey: key, kind: 'local_issue', nativeId, code, ...(shown ? { title: shown } : {}),
        count: (prior?.count ?? 0) + 1, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now,
        ...(issue.quarantine ? { evidenceDigest: boundedString(issue.quarantine.evidenceDigest, 'evidenceDigest') } : {}) });
      if (issue.quarantine) tx.objectStore(STORES.localSyncExclusions).put({ scopeKey: key, nativeId,
        decisionId: id, rootNativeId: boundedString(issue.quarantine.rootNativeId, 'rootNativeId'), generation: input.generation });
    });
  }

  async function listLocalIssues(input: SyncScope): Promise<LocalIssueRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
      localIssueRange(key), Number.MAX_SAFE_INTEGER);
    await completion;
    return rows.map((row) => clone({ nativeId: String(row.nativeId), code: String(row.code),
      ...(typeof row.title === 'string' ? { title: row.title } : {}), count: Number(row.count),
      firstSeenAt: Number(row.firstSeenAt), lastSeenAt: Number(row.lastSeenAt) }));
  }

  async function listOpenIngressIssues(input: SyncScope): Promise<LocalIssueRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction([STORES.diagnostics, STORES.bookmarkEvents, STORES.queue, STORES.receipts], 'readonly'); const done = transactionDone(tx);
    const rows = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope)
      .getAll(IDBKeyRange.bound([key, `ingress:${key}:`], [key, `ingress:${key}:\uffff`])));
    const issues: LocalIssueRecord[] = [];
    for (const row of rows) {
      const park = row.park as UnknownRecord | undefined; if (typeof park?.eventId !== 'string') continue;
      const event = await requestValue<BookmarkEventRecord | undefined>(tx.objectStore(STORES.bookmarkEvents).get([key, park.eventId]));
      const issue = openIngressIssue(row, event);
      if (!issue) continue;
      const seen = new Set<string>(); let current = issue; let rootCause = issue.rootCause;
      for (let depth = 0; depth < 64; depth++) {
        const token = current.dependencyOpId ?? current.dependencyEventId;
        if (!token) break;
        if (seen.has(token)) { rootCause = 'dependency_cycle'; break; }
        seen.add(token);
        if (current.dependencyOpId) {
          const queued = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, token]));
          rootCause = typeof (queued?.recovery as UnknownRecord | undefined)?.code === 'string'
            ? String((queued!.recovery as UnknownRecord).code) : `upload_${queued?.status ?? 'missing'}`;
          break;
        }
        const blocker = await requestValue<BookmarkEventRecord | undefined>(tx.objectStore(STORES.bookmarkEvents).get([key, token]));
        if (blocker?.opId) { current = { ...current, dependencyOpId: blocker.opId }; continue; }
        const diagnostic = rows.find(row => (row.park as UnknownRecord | undefined)?.eventId === token);
        const next = diagnostic ? openIngressIssue(diagnostic, blocker) : undefined;
        rootCause = next?.code ?? `event_${blocker?.status ?? 'missing'}`;
        if (!next) break; current = next;
      }
      issues.push({ ...issue, ...(rootCause ? { rootCause } : {}) });
    }
    await done; return mergeLocalIssues(issues);
  }

  return { probeMappingRecord, setAsidePullEvent, recordApplyFailure, listPullIssues, recordLocalIssue, listLocalIssues,
    listOpenIngressIssues, ...createPullItemRetryRepository(ctx) };
}

/** Automatic recovery retains unresolved evidence; only proved resolution or explicit repair closes it. */
export function pullIssueRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, prefix(key)], [key, `${prefix(key)}\uffff`]);
}

export function localIssueRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, localPrefix(key)], [key, `${localPrefix(key)}\uffff`]);
}

/** A bounded issue fact, shared by Pull application and Snapshot recovery transactions. */
export async function putPullIssueFact(tx: IDBTransaction, key: string, issue: {
  readonly code: string; readonly nodeId: string; readonly eventId: string; readonly title?: string; readonly now: number;
  readonly conflictOpIds?: readonly string[];
}): Promise<void> {
  const rows = tx.objectStore(STORES.diagnostics); const id = `${prefix(key)}${issue.nodeId}`;
  const prior = await requestValue(rows.get(id)) as PullIssueRecord | undefined;
  const title = prior?.title ?? issue.title?.slice(0, PULL_ISSUE_TITLE_MAX);
  const conflictOpIds = issue.conflictOpIds?.length && (!prior || prior.conflictOpIds?.length)
    ? [...new Set([...prior?.conflictOpIds ?? [], ...issue.conflictOpIds])] : undefined;
  rows.put({ id, scopeKey: key, kind: 'pull_issue', nodeId: issue.nodeId, code: prior?.code ?? issue.code,
    ...(conflictOpIds ? { conflictOpIds } : {}),
    eventId: issue.eventId, ...(title ? { title } : {}), count: (prior?.count ?? 0) + 1,
    firstSeenAt: prior?.firstSeenAt ?? issue.now, lastSeenAt: issue.now });
}

/** Clear only a conflict-derived hold whose full node state actually landed in this transaction. */
export async function settleConflictPullIssue(tx: IDBTransaction, key: string, event: UnknownRecord,
  resolved: readonly string[]): Promise<void> {
  if (!resolved.length) return;
  const payload = event.payload as { operation?: { targetId?: string } };
  const nodeId = payload.operation?.targetId;
  if (!nodeId || !(event.pendingMappings as MappingInput[] | undefined)?.some(row => row.colpId === nodeId)) return;
  const rows = tx.objectStore(STORES.diagnostics); const id = `${prefix(key)}${nodeId}`;
  const issue = await requestValue<PullIssueRecord | undefined>(rows.get(id));
  if (issue?.conflictOpIds?.length && issue.conflictOpIds.every(opId => resolved.includes(opId))) rows.delete(id);
}
