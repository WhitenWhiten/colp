import { liveCreateNativeId, plannedCreateNativeId } from './bookmark-event-codec.js';
import { BOOKMARK_EVENT_MAX_PAGES, BOOKMARK_EVENT_PAGE_SIZE } from './bookmark-event-pages.js';
import { isSequenceReuseCode } from './sequence-reuse-settlement.js';
import type {
  BookmarkEventRecord, JsonObject, QueueOperation, ReceiptInput, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'listQueue' | 'getQueueReceipt' | 'getMappingByColpId' | 'getMappingByNativeId' | 'listBookmarkEvents'
  | 'repairSequenceReuseRow' | 'putScopeDiagnostic'>;

export interface SequenceReuseProjection {
  readonly targetId: string;
  readonly revision: string;
}

export interface SequenceReuseEvidence {
  readonly projection: SequenceReuseProjection;
  /** Native node already bound by this create, when the durable mapping still proves it. */
  readonly nativeId?: string;
  /** Applied receipt already on record for this sequence; reused verbatim instead of synthesizing one. */
  readonly receipt?: ReceiptInput;
}

export interface SequenceReuseRepairLookup {
  lookupProjection?(opId: string, queue: QueueOperation): Promise<SequenceReuseProjection | null>;
}

export type SequenceReuseRepairAction =
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'terminal'; readonly receipt: ReceiptInput;
    readonly authoritativeCreate?: { readonly nativeId: string; readonly targetId: string; readonly revision: string } };

const PAGE = 200;

/**
 * Durable local proof that the server already executed this operation:
 * an applied/rebased receipt for the sequence, or a create whose local native
 * node is already bound to an authoritative colpId. Optimistic `local-*`
 * projections are deliberately not evidence — replaying is safer than
 * converging onto unproven bytes.
 */
export async function findSequenceReuseEvidence(store: Store, scope: SyncScope,
  queue: QueueOperation): Promise<SequenceReuseEvidence | null> {
  const natives = queue.payload.type === 'create_node' ? await createNativeCandidates(store, scope, queue) : [];
  const receipt = await store.getQueueReceipt(scope, queue.sequence);
  const applied = receiptAppliedTarget(receipt?.result);
  if (receipt && applied) return { projection: applied, receipt, ...nativeField(natives[0]) };
  const bound = await liveBinding(store, scope, natives);
  return bound ? { projection: bound.projection, ...nativeField(bound.nativeId) } : null;
}

/** Terminal repair action for a row whose authoritative projection is known. */
export function sequenceReuseRepairAction(queue: QueueOperation,
  evidence: SequenceReuseEvidence): SequenceReuseRepairAction {
  const receipt = evidence.receipt ?? receiptFromProjection(queue, evidence.projection);
  return { outcome: 'terminal', receipt,
    ...(evidence.nativeId && queue.payload.type === 'create_node'
      ? { authoritativeCreate: { nativeId: evidence.nativeId, targetId: evidence.projection.targetId,
        revision: evidence.projection.revision } }
      : {}) };
}

/**
 * Scans both settlement states that can carry a reuse refusal. A row that
 * cannot be converged is left exactly as it is — in particular its replay
 * backoff is never rewritten to zero — and leaves an attention record on the
 * existing scope-diagnostic channel.
 */
export async function repairSequenceReuseRejected(store: Store, scope: SyncScope,
  lookup: SequenceReuseRepairLookup = {}): Promise<{ readonly repaired: number; readonly attention: number }> {
  let repaired = 0; let attention = 0;
  for (const status of ['rejected', 'unknown'] as const) {
    let after = 0;
    for (;;) {
      const page = await store.listQueue(scope, status, after, PAGE);
      for (const row of page) {
        if (!isSequenceReuseCode(row.recovery?.code ?? '')) continue;
        const evidence = await reuseEvidence(store, scope, row, lookup);
        if (!evidence) {
          attention += 1;
          await recordReuseAttention(store, scope, row);
          continue;
        }
        await store.repairSequenceReuseRow(scope, row.sequence, sequenceReuseRepairAction(row, evidence));
        repaired += 1;
      }
      if (page.length < PAGE) break;
      after = page[page.length - 1]!.sequence;
    }
  }
  return { repaired, attention };
}

async function reuseEvidence(store: Store, scope: SyncScope, row: QueueOperation,
  lookup: SequenceReuseRepairLookup): Promise<SequenceReuseEvidence | null> {
  const evidence = await findSequenceReuseEvidence(store, scope, row);
  if (evidence || !lookup.lookupProjection) return evidence;
  const override = await lookup.lookupProjection(row.opId, row);
  if (!override) return null;
  const natives = row.payload.type === 'create_node' ? await createNativeCandidates(store, scope, row) : [];
  return { projection: override, ...nativeField(natives[0]) };
}

/** Native candidates for a create, cheapest durable identity first. */
async function createNativeCandidates(store: Store, scope: SyncScope, queue: QueueOperation): Promise<string[]> {
  const candidates: string[] = [];
  const planned = plannedCreateNativeId(queue.opId);
  if (planned) candidates.push(planned);
  const pending = await store.getMappingByColpId(scope, `pending-${queue.opId}`);
  if (pending && liveCreateNativeId(pending.nativeId)) candidates.push(pending.nativeId);
  if (candidates.length === 0) {
    const fromInbox = await findProcessedCreateNativeId(store, scope, queue.opId);
    if (fromInbox) candidates.push(fromInbox);
  }
  return [...new Set(candidates)];
}

/** The applied native binding, when a locally known native already resolves to a server identity. */
async function liveBinding(store: Store, scope: SyncScope, natives: readonly string[]): Promise<{
  readonly nativeId: string; readonly projection: SequenceReuseProjection } | null> {
  for (const nativeId of natives) {
    const mapping = await store.getMappingByNativeId(scope, nativeId);
    if (!mapping || localIdentity(mapping.colpId) || localRevision(mapping.projection.revision)) continue;
    return { nativeId, projection: { targetId: mapping.colpId, revision: mapping.projection.revision } };
  }
  return null;
}

async function findProcessedCreateNativeId(store: Store, scope: SyncScope, opId: string): Promise<string | null> {
  let after = 0;
  for (let page = 0; page < BOOKMARK_EVENT_MAX_PAGES; page += 1) {
    const rows: readonly BookmarkEventRecord[] = await store.listBookmarkEvents(scope, after, BOOKMARK_EVENT_PAGE_SIZE);
    const match = rows.find((row) => row.opId === opId && row.kind === 'create' && row.status === 'processed');
    if (match) return match.nativeId;
    if (rows.length < BOOKMARK_EVENT_PAGE_SIZE) return null;
    after = rows[rows.length - 1]!.ordinal;
  }
  return null;
}

function nativeField(nativeId: string | undefined): { readonly nativeId?: string } {
  return nativeId === undefined ? {} : { nativeId };
}

function localIdentity(value: string): boolean {
  return value.startsWith('pending-') || value.startsWith('local-') || value.startsWith('recovery:')
    || value.startsWith('sidecar:') || value.startsWith('unmounted:');
}

function localRevision(value: string): boolean {
  return value.startsWith('local-') || value.startsWith('pending-');
}

async function recordReuseAttention(store: Store, scope: SyncScope, row: QueueOperation): Promise<void> {
  try {
    await store.putScopeDiagnostic(scope, { kind: 'sequence_reuse_repair', code: 'unprovable_reuse',
      details: { opId: row.opId, sequence: row.sequence, status: row.status, code: row.recovery?.code ?? '' } });
  } catch { /* attention is already reported through the returned count */ }
}

function receiptAppliedTarget(result: JsonObject | undefined): SequenceReuseProjection | null {
  const results = result?.results;
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== 'object' || Array.isArray(results[0])) {
    return null;
  }
  const row = results[0] as JsonObject;
  if ((row.status !== 'applied' && row.status !== 'rebased') || typeof row.targetId !== 'string'
      || typeof row.revision !== 'string' || row.targetId.startsWith('pending-')
      || row.revision.startsWith('local-')) return null;
  return { targetId: row.targetId, revision: row.revision };
}

function receiptFromProjection(queue: QueueOperation, projection: SequenceReuseProjection): ReceiptInput {
  return {
    opId: queue.opId, operationDigest: queue.digest, kind: 'terminal',
    receiptId: `push-${queue.opId}`, resultDigest: `sha256:repair-${queue.opId}`,
    result: {
      batchId: queue.attempt?.batchId ?? queue.batchId,
      results: [{
        opId: queue.opId, sequence: queue.sequence, status: 'applied',
        targetId: projection.targetId, revision: projection.revision, cursor: 'repair', warnings: [],
      }],
      serverCursor: 'repair',
    },
  };
}
