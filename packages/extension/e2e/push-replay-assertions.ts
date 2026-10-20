import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import type { QueueOperation } from '../src/sync-state-store.js';
import type { ReceiptRecord } from '../src/sync-state/types.js';
import type { PushRequestObservation } from './real-stack.js';

export interface PushLocalEvidence {
  readonly queue: readonly QueueOperation[];
  readonly receipts: readonly ReceiptRecord[];
  readonly compactSummaries: readonly Record<string, unknown>[];
}
export interface PushReplayObservations {
  readonly pushRequests: readonly PushRequestObservation[];
  readonly serverMutationCount: number;
  readonly sequenceReceipts: readonly {
    readonly op_id: string; readonly sequence_number: string | number;
    readonly result_digest: string; readonly result_json: Record<string, unknown>;
  }[];
}
interface PushDocument {
  readonly sessionId: string; readonly batchId: string; readonly atomic: false;
  readonly operations: readonly Record<string, unknown>[];
}

export function queueByOpId(state: Pick<PushLocalEvidence, 'queue'>, opId: string): QueueOperation {
  const matches = state.queue.filter(row => row.opId === opId);
  expect(matches, `one durable queue row for ${opId}`).toHaveLength(1);
  return matches[0]!;
}

/** Before a terminal receipt, compaction must never erase or rewrite a retained attempt. */
export function expectRetainedPushAttempt(before: QueueOperation, state: PushLocalEvidence): QueueOperation {
  const after = queueByOpId(state, before.opId);
  expectIdentity(before, after);
  expect(before.attempt).toBeDefined();
  expect(after.status).not.toBe('terminal');
  expect(after.payload).toEqual(before.payload);
  expect(after.attempt).toEqual(before.attempt);
  expect(state.compactSummaries.filter(row => row.kind === 'queue' && row.opId === before.opId)).toHaveLength(0);
  return after;
}

/** Browser restarts lose Session secrets; rebinding still requires an explicit 401. */
export function expectAuthenticatedRestartReplay(
  before: QueueOperation, after: PushLocalEvidence, observed: PushReplayObservations,
): void {
  expect(before.attempt).toBeDefined();
  expectAuthenticatedReplay(before, after, observed);
}

/** The forced-401 case observes both real requests after seeding an unattempted row. */
export function expectRejectedSessionReplay(
  before: QueueOperation, after: PushLocalEvidence, observed: PushReplayObservations,
): void {
  expect(before.status).toBe('pending'); expect(before.attempt).toBeUndefined();
  expectAuthenticatedReplay(before, after, observed);
}

function expectAuthenticatedReplay(before: QueueOperation, after: PushLocalEvidence, observed: PushReplayObservations) {
  const requests = requestsFor(before, observed);
  const original = requests[0]!;
  const rebound = requests.findIndex(request => request.body !== original.body);
  expect(rebound, 'a new Session envelope follows the rejected retained request').toBeGreaterThan(0);
  expect(requests[rebound - 1]).toMatchObject({ responseStatus: 401, responseCode: 'authentication_required' });
  const restored = requests[rebound]!;
  const originalDocument = document(original); const restoredDocument = document(restored);
  expect(restoredDocument.sessionId).not.toBe(originalDocument.sessionId);
  expect(restoredDocument.batchId).not.toBe(originalDocument.batchId);
  // requestsFor requires each actual HTTP body to have canonical encoding. This
  // comparison therefore preserves operation bytes, including key order and escaping.
  expect(JSON.stringify(restoredDocument.operations)).toBe(JSON.stringify(originalDocument.operations));
  for (const request of requests.slice(0, rebound)) expectExactRequest(request, original);
  for (const request of requests.slice(rebound)) expectExactRequest(request, restored);
  expectSuccessfulPush(before, after, observed);
}

export function expectSameSessionReplay(
  before: QueueOperation, after: PushLocalEvidence, observed: PushReplayObservations,
): void {
  expect(before.attempt).toBeDefined();
  const requests = requestsFor(before, observed);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const request of requests) expectExactRequest(request, requests[0]!);
  const retained = queueByOpId(after, before.opId);
  if (retained.attempt) expect(retained.attempt).toEqual(before.attempt);
  expectSuccessfulPush(before, after, observed);
}

/** Terminal rows may retain bytes or have an Ack-driven compact summary; both need receipt proof. */
export function expectSuccessfulPush(
  before: QueueOperation, state: PushLocalEvidence, observed: PushReplayObservations,
): void {
  const after = queueByOpId(state, before.opId); expectIdentity(before, after);
  expect(after.status).toBe('terminal');
  const requests = requestsFor(before, observed); const accepted = requests.at(-1)!;
  expect(accepted.responseStatus).toBe(200);
  const receipts = state.receipts.filter(receipt => receipt.opId === before.opId);
  expect(receipts).toHaveLength(1); const receipt = receipts[0]!;
  expect(receipt).toMatchObject({ scopeKey: before.scopeKey, opId: before.opId, sequence: before.sequence,
    operationDigest: before.digest, kind: 'terminal', receiptId: `push-${before.opId}` });
  expect(receipt.result).toBeDefined();
  expect(receipt.resultDigest).toBe(sha256(canonicalJson(receipt.result)));
  // Singleton Push results use the server's Session/key HMAC envelope, while
  // the request retains the client's UUID batch. Compare the actual response
  // and independently derived PG authority binding, not those two distinct IDs.
  const acceptedResult = successfulResponse(accepted);
  expect(receipt.result).toEqual(acceptedResult);
  expect(receipt.result!.results).toEqual([expect.objectContaining({ opId: before.opId, sequence: before.sequence,
    status: expect.stringMatching(/^(applied|rebased|noop)$/u) })]);
  const serverReceipts = observed.sequenceReceipts.filter(row => row.op_id === before.opId);
  expect(serverReceipts).toHaveLength(1); const serverReceipt = serverReceipts[0]!;
  expect(Number(serverReceipt.sequence_number)).toBe(before.sequence);
  expect(serverReceipt.result_digest).toBe(sha256(canonicalJson({
    contract: 'known.sync-sequence-result.v1', result: serverReceipt.result_json,
  })));
  const { batchId: _storedBatch, ...storedResult } = serverReceipt.result_json;
  const { batchId: _replayedBatch, ...replayedResult } = receipt.result!;
  // A replay under a new Session rewraps only the HTTP envelope. The canonical
  // receipt must still equal an actual successful response for this operation.
  expect(requests.filter(request => request.responseStatus === 200).map(successfulResponse))
    .toContainEqual(serverReceipt.result_json);
  expect(replayedResult).toEqual(storedResult);
  expect(observed.serverMutationCount).toBe(1);
  if (after.payload.compacted === true) {
    expect(after.attempt).toBeUndefined();
    const summaries = state.compactSummaries.filter(row => row.kind === 'queue' && row.opId === before.opId);
    expect(summaries).toEqual([{ scopeKey: before.scopeKey, kind: 'queue', id: before.opId,
      opId: before.opId, sequence: before.sequence, digest: before.digest }]);
    // These replay fixtures create a native bookmark; its retained native facts
    // must also survive compaction, independently of the transport envelope.
    expect(before.payload.type).toBe('create_node');
    const payload = before.payload.payload as Record<string, unknown>;
    const node = payload.node as Record<string, unknown>;
    expect(after.payload).toEqual({ compacted: true, type: 'create_node', payload: {
      parentId: payload.parentId, node: Object.fromEntries(['kind', 'title', 'url', 'folderRole']
        .filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]])),
    } });
  } else {
    expect(after.payload).toEqual(before.payload);
    expect(after.attempt).toMatchObject({ body: accepted.body, bodyDigest: accepted.fingerprint,
      sessionId: document(accepted).sessionId, batchId: document(accepted).batchId,
      idempotencyKey: before.idempotencyKey });
  }
}

function requestsFor(before: QueueOperation, observed: Pick<PushReplayObservations, 'pushRequests'>) {
  const requests = observed.pushRequests.filter(request => document(request).operations.some(op => op.opId === before.opId));
  expect(requests.length, `real HTTP Push evidence for ${before.opId}`).toBeGreaterThan(0);
  expect(before.digest).toBe(`sha256:${sha256(canonicalJson(before.payload))}`);
  for (const request of requests) {
    expect(request.fingerprint).toBe(sha256(request.body));
    expect(request.body).toBe(canonicalJson(document(request)));
    expect(Object.keys(document(request))).toEqual(['atomic', 'batchId', 'operations', 'sessionId']);
    expect(document(request).atomic).toBe(false);
    expect(document(request).batchId.startsWith(`${document(request).sessionId}.`)).toBe(true);
    expect(document(request).operations).toEqual([before.payload]);
    expect(request.headers['idempotency-key']).toBe(before.idempotencyKey);
  }
  if (before.attempt) {
    expect(requests[0]!.body).toBe(before.attempt.body);
    expect(requests[0]!.fingerprint).toBe(before.attempt.bodyDigest);
    expect(document(requests[0]!).sessionId).toBe(before.attempt.sessionId);
    expect(document(requests[0]!).batchId).toBe(before.attempt.batchId);
    expect(before.attempt.idempotencyKey).toBe(before.idempotencyKey);
  }
  return requests;
}
function expectExactRequest(actual: PushRequestObservation, expected: PushRequestObservation) {
  expect(actual.body).toBe(expected.body); expect(actual.fingerprint).toBe(expected.fingerprint);
}
function expectIdentity(before: QueueOperation, after: QueueOperation) {
  for (const key of ['scopeKey', 'opId', 'sequence', 'digest', 'idempotencyKey', 'batchId', 'baseRevision', 'operationRevision'] as const) {
    expect(after[key], `retained operation ${key}`).toBe(before[key]);
  }
}
function document(request: PushRequestObservation): PushDocument { return JSON.parse(request.body) as PushDocument; }
function successfulResponse(request: PushRequestObservation): Record<string, unknown> {
  expect(request.responseStatus).toBe(200);
  expect(request.responseBody).toBeDefined();
  const result = JSON.parse(request.responseBody!) as Record<string, unknown>;
  const sessionId = document(request).sessionId;
  expect(request.expectedServerBatchId?.startsWith(`${sessionId}.`)).toBe(true);
  expect(request.expectedServerBatchId?.slice(sessionId.length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(result.batchId).toBe(request.expectedServerBatchId);
  return result;
}
function sha256(bytes: string): string { return createHash('sha256').update(bytes, 'utf8').digest('hex'); }
// Independent test-side encoding: do not use the encoder or digest implementation under test.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('expected_json_evidence'); return encoded;
}
