import { SyncFailureError } from './sync-failure-class.js';
import { reasonCode } from './push-error-code.js';
import { colpCredentialHeaders } from './auth-client.js';
import { readBoundedJson } from './json-response.js';
import { parseSyncPushResult } from './sync-push-wire.js';
import type { JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

const REQUEST_BYTES = 64 * 1024;
const RESPONSE_BYTES = 128 * 1024;

/** Only fresh first-run creates with already canonical placement can share transport. */
export function batchableBootstrapCreate(row: QueueOperation): boolean {
  return bootstrapBatchExclusion(row) === undefined;
}

export function bootstrapBatchExclusion(row: QueueOperation): string | undefined {
  const payload = row.payload.payload as JsonObject | undefined;
  const node = payload?.node as JsonObject | undefined;
  if (!row.opId.startsWith('b3.') || row.idempotencyKey !== row.opId
      || row.payload.type !== 'create_node' || row.mediaType !== 'application/json') return 'operation_kind';
  if (!Array.isArray(row.payload.dependencies) || row.payload.dependencies.length) return 'dependency';
  if (typeof payload?.parentId !== 'string' || /^(pending-|mount:|local-)/u.test(payload.parentId)) return 'parent_pending';
  if (payload.afterId != null || payload.beforeId != null) return 'placement_anchor';
  if (node?.folderRole !== undefined) return 'mount_role';
  return undefined;
}

type BatchOutcome = 'terminal' | 'unknown' | 'blocked' | 'deferred' | 'recovery' | 'rejected' | 'gap';

export async function sendBootstrapCreateBatch(input: {
  readonly first: QueueOperation; readonly fresh: boolean; readonly limit: number;
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly ownerId: string; readonly fence: number; readonly now: () => number;
  readonly session: StoredSession; readonly credential: Pick<StoredCredential, 'accessToken'>;
  readonly endpoint: string; readonly fetch: typeof fetch; readonly origin?: string; readonly timeoutMs: number;
  readonly prepare: (row: QueueOperation) => Promise<QueueOperation>;
  readonly settle: (row: QueueOperation, response: Response) => Promise<BatchOutcome>;
  readonly unknown: (row: QueueOperation, code: string, retryAfter?: string | null) => Promise<unknown>;
  readonly barrier: () => Promise<boolean>;
  readonly beforeDispatch?: (queue: QueueOperation) => Promise<void>;
  readonly dispatch?: (rows: readonly QueueOperation[], send: () => Promise<Response>) => Promise<Response>;
  readonly onNetworkResponse?: () => void | Promise<void>;
}): Promise<{ outcome: BatchOutcome; count: number; sequence: number } | null> {
  if (!input.fresh || input.limit < 2 || !batchableBootstrapCreate(input.first)) return null;
  let bytes = new TextEncoder().encode(JSON.stringify(input.first.payload)).length + 512;
  const following = await input.store.claimFollowingQueue(input.scope, input.ownerId, input.fence,
    input.now(), input.first.sequence, Math.min(49, input.limit - 1), (row) => {
      if (!batchableBootstrapCreate(row)) return false;
      bytes += new TextEncoder().encode(JSON.stringify(row.payload)).length + 1;
      return bytes <= REQUEST_BYTES;
    });
  if (following.length === 0) return null;
  const rows = [input.first, ...following]; let settled = 0; let retryAfter: string | null = null;
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let index = 1; index < rows.length; index += 1) {
      rows[index] = await input.prepare(rows[index]!);
      if (!batchableBootstrapCreate(rows[index]!)) throw new SyncFailureError('push_batch_placement_changed');
    }
    if (await input.barrier()) throw new SyncFailureError('push_batch_recovery_barrier');
    const batchId = `${input.session.sessionId}.${crypto.randomUUID()}`;
    const body = JSON.stringify({ sessionId: input.session.sessionId, batchId, atomic: false,
      operations: rows.map((row) => row.payload) });
    if (new TextEncoder().encode(body).length > REQUEST_BYTES) throw new SyncFailureError('push_batch_byte_limit');
    // Persisted singleton attempts are the recovery authority. Never attribute
    // a batch Problem to an individual operation: a prefix may have committed.
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new SyncFailureError('push_batch_timeout'));
    }, input.timeoutMs); });
    const idempotencyKey = `batch.${crypto.randomUUID()}`;
    const send = () => { controller.signal.throwIfAborted(); return input.fetch(input.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
      signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        ...colpCredentialHeaders(input.credential.accessToken), 'Idempotency-Key': idempotencyKey,
        ...(input.origin ? { Origin: input.origin } : {}) }, body }); };
    const dispatch = async () => {
      for (const row of rows) await input.beforeDispatch?.(row);
      if (await input.barrier()) throw new SyncFailureError('push_batch_recovery_barrier');
      return input.dispatch ? input.dispatch(rows, send) : send();
    };
    const response = await Promise.race([dispatch(), timeout]);
    retryAfter = response.headers.get('Retry-After'); await input.onNetworkResponse?.();
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')) {
      throw new SyncFailureError('push_batch_response_unknown');
    }
    const value = await Promise.race([readBoundedJson(response, RESPONSE_BYTES, 'push_batch_response_invalid'), timeout]);
    const document = value as { batchId?: unknown; results?: unknown; serverCursor?: unknown } | null;
    if (!document || !Array.isArray(document.results) || document.results.length !== rows.length
        || Object.keys(document).some((key) => !['batchId', 'results', 'serverCursor'].includes(key))) {
      throw new SyncFailureError('push_batch_response_invalid');
    }
    const results = document.results;
    // Validate every identity/status before publishing any local receipt.
    const singles = rows.map((row, index) => parseSyncPushResult({ ...document, results: [results[index]] }, row).document);
    let outcome: BatchOutcome = 'terminal';
    for (let index = 0; index < rows.length; index += 1) {
      outcome = await input.settle(rows[index]!, new Response(JSON.stringify(singles[index]), {
        status: 200, headers: { 'Content-Type': 'application/json' } }));
      settled = index + 1;
      if (outcome !== 'terminal') break;
    }
    for (const row of rows.slice(settled)) await input.unknown(row, 'push_batch_prefix_pending');
    return { outcome, count: rows.length, sequence: rows[Math.max(0, settled - 1)]!.sequence };
  } catch (error) {
    const code = reasonCode(error, 'push_batch_response_unknown');
    for (const row of rows.slice(settled)) {
      const current = await input.store.getQueueByOpId(input.scope, row.opId);
      if (current?.status === 'claimed' && current.retry.ownerId === input.ownerId
          && current.retry.fence === input.fence) await input.unknown(current, code, retryAfter);
    }
    return { outcome: 'unknown', count: rows.length, sequence: input.first.sequence };
  } finally { if (timer) clearTimeout(timer); }
}
