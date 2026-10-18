import { boundedString, clone, safeInteger } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { validateMapping } from './mapping-repository.js';
import { putPullTerminalFacts } from './pull-workset.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type MappingInput, type SyncScope, type UnknownRecord } from './types.js';

/** A remote node this browser could not take in. Its events were committed without touching the browser. */
export interface PullIssueRecord {
  readonly nodeId: string;
  readonly code: string;
  readonly eventId: string;
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/** A browser bookmark change that could not be tied to the library and was not synced. */
export interface LocalIssueRecord {
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
/** States an event can fail in before its browser call changed anything. */
const SET_ASIDE_STATES = new Set(['staged', 'intent_prepared', 'browser_call_started']);
const localPrefix = (key: string) => `local-issue:${key}:`;

/**
 * B7: an item a Pull page cannot store is set aside, not a reason to stop the
 * page. The event commits with nothing to write, so the page completes and the
 * cursor moves on; the node and why it was set aside stay in a durable row
 * until a delete of the node or a replica rebuild clears it.
 */
export function createPullIssueRepository(ctx: SyncStoreRuntime) {
  /** Validates the mapping a Pull event would store, before any browser call. Throws the codec error. */
  function probeMappingRecord(input: SyncScope, mapping: MappingInput): void {
    validateMapping(scopeKey(validateScope(input)), mapping, ctx.maxRecordBytes);
  }

  /**
   * Commits an event without touching the browser and records its node. The
   * event is staged, or failed before its browser call changed anything; its
   * apply intent, if any, settles with it. With `resolveNodeIds` (a delete of
   * set-aside nodes) those rows close instead.
   */
  async function setAsidePullEvent(input: SyncScope, eventId: string, issue: {
    readonly code: string; readonly nodeId: string; readonly title?: string;
    readonly resolveNodeIds?: readonly string[]; readonly now: number;
  }): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const code = boundedString(issue.code, 'recovery code'); const nodeId = boundedString(issue.nodeId, 'nodeId');
    const now = safeInteger(issue.now, 'now');
    const title = issue.title?.trim() ? issue.title.trim().slice(0, PULL_ISSUE_TITLE_MAX) : undefined;
    const resolved = issue.resolveNodeIds?.map((id) => boundedString(id, 'nodeId'));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.pullEvents, STORES.intents,
      STORES.diagnostics], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, boundedString(eventId, 'eventId')])) as UnknownRecord | undefined;
        if (!event || !SET_ASIDE_STATES.has(String(event.state))) throw new SyncStateError('pull_event_state_invalid');
        if (typeof event.intentId === 'string') {
          const intents = tx.objectStore(STORES.intents);
          const intent = await requestValue(intents.get([key, event.intentId])) as UnknownRecord | undefined;
          if (intent) intents.put({ ...intent, state: 'authority_committed', apiPhase: 'authority_committed',
            apiResultEvidence: { setAside: code } });
        }
        const committed = { ...event, state: 'authority_committed', pendingMappings: [], pendingObservations: [],
          pendingDeleteNativeIds: [], apiResultEvidence: { setAside: code, nodeId, ...(resolved ? { resolved: true } : {}) } };
        events.put(committed); putPullTerminalFacts(tx, key, committed);
        const rows = tx.objectStore(STORES.diagnostics); const id = `${prefix(key)}${nodeId}`;
        if (resolved) { for (const node of resolved) rows.delete(`${prefix(key)}${node}`); return; }
        const prior = await requestValue(rows.get(id)) as PullIssueRecord | undefined;
        const shown = prior?.title ?? title;
        rows.put({ id, scopeKey: key, kind: 'pull_issue', nodeId, code: prior?.code ?? code, eventId,
          ...(shown ? { title: shown } : {}),
          count: (prior?.count ?? 0) + 1, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now });
      });
  }

  async function listPullIssues(input: SyncScope): Promise<PullIssueRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
      pullIssueRange(key), Number.MAX_SAFE_INTEGER);
    await completion;
    return rows.map((row) => clone({ nodeId: String(row.nodeId), code: String(row.code), eventId: String(row.eventId),
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
  }): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const code = boundedString(issue.code, 'recovery code'); const nativeId = boundedString(issue.nativeId, 'nativeId');
    const now = safeInteger(issue.now, 'now');
    const title = issue.title?.trim() ? issue.title.trim().slice(0, PULL_ISSUE_TITLE_MAX) : undefined;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const rows = tx.objectStore(STORES.diagnostics);
      const id = `${localPrefix(key)}${code}:${nativeId}`;
      const prior = await requestValue(rows.get(id)) as LocalIssueRecord | undefined;
      const shown = prior?.title ?? title;
      rows.put({ id, scopeKey: key, kind: 'local_issue', nativeId, code, ...(shown ? { title: shown } : {}),
        count: (prior?.count ?? 0) + 1, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now });
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

  return { probeMappingRecord, setAsidePullEvent, listPullIssues, recordLocalIssue, listLocalIssues };
}

/** Recovery cutover rebuilds the replica from a Snapshot, so every Pull issue is decided again. */
export function pullIssueRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, prefix(key)], [key, `${prefix(key)}\uffff`]);
}

export function localIssueRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, localPrefix(key)], [key, `${localPrefix(key)}\uffff`]);
}
