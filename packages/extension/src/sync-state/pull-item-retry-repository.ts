import { isSetAsideEvent, planItemRetry, pullEventTouchesNode, restagedPullEvent, type PullItemRetryOutcome } from '../pull-item-retry-plan.js';
import { boundedString } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange } from './idb.js';
import { virtualPlaceholderNativeId } from './mapping-repository.js';
import { orderEventsByPageChain } from './pull-workset.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { IntentRecord, SyncScope, UnknownRecord } from './types.js';

/** The row `putPullIssueFact` keeps for one set-aside node. */
const pullIssueFactId = (key: string, nodeId: string): string => `pull-issue:${key}:${nodeId}`;

/** A bookmark that stands for a node in the browser, not a placeholder that only reserves its identity. */
const landedNativeId = (nativeId: string): boolean => !virtualPlaceholderNativeId(nativeId) && !nativeId.startsWith('pending');

/** An earlier try left proof that a browser call may have changed something; such an event is never played again. */
function callMayHaveLanded(intent: IntentRecord | undefined): boolean {
  if (!intent) return false;
  const result = intent.apiResultEvidence as { readonly nativeId?: unknown } | null | undefined;
  return typeof result?.nativeId === 'string' || intent.nativeEventEvidence != null
    || intent.nativeResult === 'applied_with_evidence' || intent.replayState === 'awaiting_receipt';
}

/**
 * Trying a remote item again (D3 / B-07): "re-stage the stored event, accept the server's state". The held events of a
 * node go back to `staged` on their own completed page, marked as retries, and the ordinary apply pass takes them in
 * like a deferred event. Nothing here touches the cursor, an Ack or a page.
 */
export function createPullItemRetryRepository(ctx: SyncStoreRuntime) {
  async function restagePullIssues(input: SyncScope, nodeIds: readonly string[]):
  Promise<ReadonlyArray<readonly [string, PullItemRetryOutcome | 'restaged']>> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const wanted = [...new Set(nodeIds.map(nodeId => boundedString(nodeId, 'nodeId')))];
    const outcomes = new Map<string, PullItemRetryOutcome | 'restaged'>(wanted.map(nodeId => [nodeId, 'unavailable']));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.pullEvents, STORES.pullPages, STORES.intents,
      STORES.deleteMembers, STORES.diagnostics, STORES.mappings], 'readwrite', async tx => {
      const scope = await requireActiveScope(tx, key);
      if (scope.lifecycle !== 'active') return;
      const rows = tx.objectStore(STORES.diagnostics); const eventStore = tx.objectStore(STORES.pullEvents);
      const events = await cursorPage<UnknownRecord>(eventStore, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const pages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullPages), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const completed = new Set(pages.filter(page => page.state === 'page_complete').map(page => String(page.pageId)));
      const ordered = orderEventsByPageChain(events, pages);
      const rank = new Map(ordered.map((event, index) => [String(event.eventId), index]));
      const open = async (nodeId: string) => {
        const issue = await requestValue(rows.get(pullIssueFactId(key, nodeId))) as UnknownRecord | undefined;
        return issue?.kind === 'pull_issue' ? issue : undefined;
      };
      const planned: Array<{ readonly nodeId: string; readonly eventIds: readonly string[]; readonly parentId?: string }> = [];
      for (const nodeId of wanted) {
        const issue = await open(nodeId);
        // A hold that a conflict decision settles is not tried again from here.
        if (!issue || Array.isArray(issue.conflictOpIds) && issue.conflictOpIds.length > 0) continue;
        const mapping = await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpId)
          .get([key, nodeId])) as { readonly nativeId?: unknown } | undefined;
        const plan = planItemRetry(ordered.filter(event => pullEventTouchesNode(event, nodeId)),
          typeof mapping?.nativeId === 'string' && landedNativeId(mapping.nativeId));
        if (plan.outcome === 'superseded') { rows.delete(pullIssueFactId(key, nodeId)); outcomes.set(nodeId, 'superseded'); continue; }
        if (plan.outcome !== 'restage') continue;
        const held = ordered.filter(event => plan.eventIds.includes(String(event.eventId)));
        // Events of a page that is still being applied belong to the page flow; the intents must show nothing landed.
        if (held.some(event => !completed.has(String(event.pageId)) || !isSetAsideEvent(event))) continue;
        let safe = true;
        for (const event of held) {
          if (typeof event.intentId !== 'string') continue;
          const intent = await requestValue(tx.objectStore(STORES.intents).get([key, event.intentId])) as IntentRecord | undefined;
          if (callMayHaveLanded(intent)) { safe = false; break; }
        }
        if (safe) planned.push({ nodeId, eventIds: plan.eventIds, ...(plan.parentId ? { parentId: plan.parentId } : {}) });
      }
      // Folders before what is inside them, as the server delivered them.
      planned.sort((left, right) => (rank.get(left.eventIds[0]!) ?? 0) - (rank.get(right.eventIds[0]!) ?? 0));
      for (const item of planned) {
        // The folder it goes into has an issue of its own: that is the one to try first.
        if (item.parentId && await open(item.parentId)) continue;
        for (const eventId of item.eventIds) {
          const event = ordered.find(row => row.eventId === eventId)!;
          if (typeof event.intentId === 'string') {
            tx.objectStore(STORES.intents).delete([key, event.intentId]);
            tx.objectStore(STORES.deleteMembers).delete(IDBKeyRange.bound([key, event.intentId], [key, event.intentId, []]));
          }
          eventStore.put(restagedPullEvent(event, input.generation));
        }
        rows.delete(pullIssueFactId(key, item.nodeId)); outcomes.set(item.nodeId, 'restaged');
      }
    });
    return [...outcomes];
  }
  return { restagePullIssues };
}
