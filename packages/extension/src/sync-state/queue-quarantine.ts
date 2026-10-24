import { describeUnreadable, readableQueueRows, tryValidateQueueRecord, type UnreadableHandler, type UnreadableQueueRow } from './queue-lenient.js';
import { validateJson } from './codec.js';
import { cursorPage } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import type { JsonObject, QueueOperation } from './types.js';

/** The code a quarantined row carries; the original bytes are kept in the diagnostics store. */
export const QUEUE_UNREADABLE = 'queue_row_unreadable';

/**
 * Scalar payload fields that stay readable on a held row so the item can still be located and
 * later changes to the same bookmark wait behind it. The operation `type` is deliberately not
 * kept: readers that see `create_node` or `move_node` expect the nested operation body.
 */
const KEPT_PAYLOAD_FIELDS = ['targetId', 'occurredAt', 'collectionId', 'replicaId'] as const;

/**
 * Rule C: the claim met a queue row that cannot be read.
 *
 * - A change that was never sent owns no server sequence. It is rewritten in place as a held
 *   item (`set_aside`, `queue_row_unreadable`) built only from what can still be trusted, so the
 *   lane goes on, a gap realign treats its slot like any other held row, and Status shows it as
 *   one item with its opId. The raw record is kept in the diagnostics store first. The
 *   browser bookmark it was captured from is untouched, and the lost-event nets capture it
 *   afresh. A record that cannot even be rewritten is removed after it has been archived.
 * - A change the server may own (a bound attempt, or a status that follows a server answer) keeps
 *   its place: the push lane waits behind it ("blocking") while Pull and Ack carry on.
 * - Settled history is stepped over.
 */
export function createQueueQuarantine(tx: IDBTransaction, key: string, maxBytes: number): UnreadableHandler {
  return (raw) => {
    const row = describeUnreadable(raw);
    if (row.kind === 'sent') return 'blocking';
    if (row.kind === 'settled' || row.sequence === undefined) return 'skipped';
    const held = heldItem(key, row, raw as Record<string, unknown>, maxBytes);
    tx.objectStore(STORES.diagnostics).put({ id: `queue-quarantine:${key}:${row.sequence}`, scopeKey: key,
      kind: 'queue_quarantine', code: QUEUE_UNREADABLE, details: { sequence: row.sequence,
        ...(row.opId === undefined ? {} : { opId: row.opId }), ...(row.status === undefined ? {} : { status: row.status }),
        repaired: held !== undefined }, record: raw });
    const queue = tx.objectStore(STORES.queue);
    if (held) queue.put(held); else queue.delete([key, row.sequence]);
    return 'repaired';
  };
}

/**
 * The rows of one sequence range, for a gap realign that renumbers them. An unreadable change that
 * was never sent is held first, so it is renumbered like any held row; `undefined` when a row in the
 * range cannot be made readable (the server may own it), and the realign leaves the lane alone.
 */
export async function readRangeQuarantining(tx: IDBTransaction, key: string, range: IDBKeyRange,
  maxBytes: number): Promise<QueueOperation[] | undefined> {
  const index = tx.objectStore(STORES.queue).index(INDEXES.queueBySequence);
  let values = await cursorPage<unknown>(index, range, Number.MAX_SAFE_INTEGER);
  if (values.every((value) => tryValidateQueueRecord(value, maxBytes))) return readableQueueRows(values, maxBytes);
  const quarantine = createQueueQuarantine(tx, key, maxBytes);
  for (const value of values) if (!tryValidateQueueRecord(value, maxBytes) && quarantine(value) !== 'repaired') return undefined;
  values = await cursorPage<unknown>(index, range, Number.MAX_SAFE_INTEGER);
  const rows = readableQueueRows(values, maxBytes);
  return rows.length === values.length ? rows : undefined;
}

function heldItem(key: string, row: UnreadableQueueRow, raw: Record<string, unknown>, maxBytes: number): QueueOperation | undefined {
  const sequence = row.sequence!;
  const text = (value: unknown, fallback: string) => typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value : fallback;
  const opId = text(raw.opId, `unreadable-${sequence}`);
  const retry = raw.retry && typeof raw.retry === 'object' ? raw.retry as Record<string, unknown> : {};
  const source = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    ? raw.payload as Record<string, unknown> : {};
  const payload: Record<string, unknown> = { type: 'unreadable', unreadable: true };
  if (typeof source.type === 'string' && source.type.length <= 64) payload.unreadableType = source.type;
  for (const field of KEPT_PAYLOAD_FIELDS) if (typeof source[field] === 'string' && source[field].length <= 512) payload[field] = source[field];
  try { validateJson(payload, 'payload'); } catch { return undefined; }
  return tryValidateQueueRecord({ scopeKey: key, sequence, opId, batchId: text(raw.batchId, opId),
    idempotencyKey: text(raw.idempotencyKey, opId), digest: text(raw.digest, 'sha256:unreadable'),
    endpointIdentity: 'syncPush', mediaType: text(raw.mediaType, 'application/json'),
    baseRevision: typeof raw.baseRevision === 'string' && raw.baseRevision.length > 0 && raw.baseRevision.length <= 512
      ? raw.baseRevision : null,
    operationRevision: text(raw.operationRevision, `local-${opId}`), status: 'set_aside',
    retry: { attempt: typeof retry.attempt === 'number' && Number.isSafeInteger(retry.attempt) && retry.attempt >= 0
      ? retry.attempt : 0, notBefore: 0 },
    recovery: { code: QUEUE_UNREADABLE }, payload: payload as JsonObject }, maxBytes);
}
