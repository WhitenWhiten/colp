import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { expectAuthenticatedRestartReplay, expectRejectedSessionReplay, expectRetainedPushAttempt,
  expectSameSessionReplay, expectSuccessfulPush, queueByOpId } from '../e2e/push-replay-assertions.js';
import type { PushRequestObservation } from '../e2e/real-stack.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';

const hash = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');
function fixture(rebind = true, compact = true) {
  // Keys are deliberately canonical in these independent wire fixtures.
  const operation: JsonObject = { baseRevision: null, collectionId: 'collection', dependencies: [],
    occurredAt: '2026-10-20T00:00:00.000Z', opId: 'operation', payload: {
      node: { kind: 'bookmark', title: 'Wire title', url: 'https://example.test/replay' }, parentId: 'root',
    }, replicaId: 'replica', sequence: 7, type: 'create_node' };
  const body = (sessionId: string) => JSON.stringify({ atomic: false, batchId: `${sessionId}.batch`, operations: [operation], sessionId });
  const serverBatch = (sessionId: string) => `${sessionId}.${createHmac('sha256', `test-secret-${sessionId}`)
    .update('known.sync-push.batch.v1\0operation').digest('base64url')}`;
  const result = (sessionId: string) => ({ batchId: serverBatch(sessionId), results: [{ opId: 'operation',
    revision: 'revision', sequence: 7, status: 'applied', targetId: 'created', warnings: [] }], serverCursor: 'cursor' });
  const request = (sessionId: string, status: number, code?: string): PushRequestObservation => ({
    url: '/v1/push', headers: { 'idempotency-key': 'operation' }, body: body(sessionId), fingerprint: hash(body(sessionId)),
    responseStatus: status, ...(code ? { responseCode: code } : {}), sessionCookiePresent: false, bearerAuthorizationPresent: true,
    responseBody: JSON.stringify(status === 200 ? result(sessionId) : { code }), expectedServerBatchId: serverBatch(sessionId),
  });
  const before: QueueOperation = { scopeKey: 'scope', sequence: 7, opId: 'operation', batchId: 'operation',
    idempotencyKey: 'operation', digest: `sha256:${hash(JSON.stringify(operation))}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: 'local-operation', status: 'unknown',
    retry: { attempt: 1, notBefore: 20 }, payload: operation, attempt: {
      sessionId: 'old', batchId: 'old.batch', idempotencyKey: 'operation', endpointIdentity: 'syncPush',
      mediaType: 'application/json', body: body('old'), bodyDigest: hash(body('old')), startedAt: 10,
    } };
  const finalSession = rebind ? 'new' : 'old';
  const after = { ...before, status: 'terminal' as QueueOperation['status'],
    payload: (compact ? { compacted: true, type: 'create_node', payload: operation.payload } : operation) as JsonObject,
    attempt: compact ? undefined : { ...before.attempt!, sessionId: finalSession, batchId: `${finalSession}.batch`,
      body: body(finalSession), bodyDigest: hash(body(finalSession)) } };
  const storedResult = result('old'); const localResult = result(finalSession);
  const state = {
    queue: [{ ...before, opId: 'unrelated', sequence: 1, status: 'pending' as const, attempt: undefined }, after],
    receipts: [{ scopeKey: 'scope', opId: 'operation', sequence: 7, operationDigest: before.digest,
      kind: 'terminal' as const, receiptId: 'push-operation', resultDigest: hash(JSON.stringify(localResult)), result: localResult }],
    compactSummaries: compact ? [{ scopeKey: 'scope', kind: 'queue', id: 'operation', opId: 'operation', sequence: 7, digest: before.digest }] : [],
  };
  const observed = { serverMutationCount: 1, pushRequests: rebind
    ? [request('old', 200), request('old', 401, 'authentication_required'), request('new', 200)]
    : [request('old', 503, 'service_unavailable'), request('old', 200)],
  sequenceReceipts: [{ op_id: 'operation', sequence_number: '7', result_json: storedResult,
    result_digest: hash(JSON.stringify({ contract: 'known.sync-sequence-result.v1', result: storedResult })) }] };
  return { before, after, state, observed };
}

for (const compact of [false, true]) {
  test(`authenticated replay preserves the operation and terminal receipt when compacted=${compact}`, () => {
    const f = fixture(true, compact);
    expectAuthenticatedRestartReplay(f.before, f.state, f.observed);
    expect(queueByOpId(f.state, f.before.opId)).toBe(f.after);
  });
  test(`same-Session retries have exact bodies and fingerprints when compacted=${compact}`, () => {
    const f = fixture(false, compact); expectSameSessionReplay(f.before, f.state, f.observed);
  });
}

test('forced 401 has real wire evidence even when the pre-send snapshot has no attempt', () => {
  const f = fixture(); const before = { ...f.before, status: 'pending' as const, attempt: undefined };
  expectRejectedSessionReplay(before, f.state, f.observed);
  expect(() => expectAuthenticatedRestartReplay(before, f.state, f.observed)).toThrow();
});

test('the real singleton contract keeps UUID request batches separate from Session/key result batches', () => {
  const f = fixture();
  const first = f.observed.pushRequests[0]!; const last = f.observed.pushRequests.at(-1)!;
  expect(JSON.parse(first.body).batchId).toBe('old.batch');
  expect(JSON.parse(last.body).batchId).toBe('new.batch');
  expect(f.observed.sequenceReceipts[0]!.result_json.batchId).toBe(first.expectedServerBatchId);
  expect(f.state.receipts[0]!.result.batchId).toBe(last.expectedServerBatchId);
  expect(first.expectedServerBatchId).not.toBe(last.expectedServerBatchId);
  expectAuthenticatedRestartReplay(f.before, f.state, f.observed);
});

test('unknown, blocked, deferred and claimed rows retain bytes before receipt/compaction', () => {
  for (const status of ['unknown', 'blocked', 'deferred', 'claimed'] as const) {
    const f = fixture(); const row = { ...f.before, status };
    const state = { queue: [row], receipts: [], compactSummaries: [] };
    expectRetainedPushAttempt(f.before, state);
    expect(() => expectRetainedPushAttempt(f.before, { ...state, queue: [{ ...row, attempt: undefined }] })).toThrow();
    expect(() => expectRetainedPushAttempt(f.before, { ...state, queue: [{ ...row,
      attempt: { ...row.attempt!, body: `${row.attempt!.body} ` } }] })).toThrow();
    expect(() => expectRetainedPushAttempt(f.before, { ...state, queue: [{ ...row, payload: { compacted: true } }] })).toThrow();
    expect(() => expectRetainedPushAttempt(f.before, { ...state, compactSummaries: f.state.compactSummaries })).toThrow();
  }
});

type Fixture = ReturnType<typeof fixture>;
const corruptions: [string, (f: Fixture) => void][] = [
  ['missing queue row', f => { f.state.queue = []; }],
  ['duplicate queue identity', f => { f.state.queue.push(f.after); }],
  ['changed queue sequence', f => { f.after.sequence += 1; }],
  ['changed queue operation digest', f => { f.after.digest = 'sha256:wrong'; }],
  ['changed queue idempotency key', f => { f.after.idempotencyKey = 'other'; }],
  ['unknown row compacted early', f => { f.after.status = 'unknown'; }],
  ['attempt removed without compaction', f => { f.after.payload = f.before.payload; }],
  ['missing compact summary', f => { f.state.compactSummaries = []; }],
  ['wrong compact summary digest', f => { f.state.compactSummaries[0]!.digest = 'sha256:wrong'; }],
  ['wrong compact summary sequence', f => { f.state.compactSummaries[0]!.sequence += 1; }],
  ['duplicate compact summary', f => { f.state.compactSummaries.push(f.state.compactSummaries[0]!); }],
  ['lost native repair facts', f => { f.after.payload = { compacted: true, type: 'create_node' }; }],
  ['missing local receipt', f => { f.state.receipts = []; }],
  ['wrong local operation digest', f => { f.state.receipts[0]!.operationDigest = 'sha256:wrong'; }],
  ['wrong local receipt sequence', f => { f.state.receipts[0]!.sequence += 1; }],
  ['wrong local receipt digest', f => { f.state.receipts[0]!.resultDigest = 'wrong'; }],
  ['local receipt substituted with request UUID and a valid digest', f => {
    const receipt = f.state.receipts[0]!; receipt.result.batchId = 'new.batch';
    receipt.resultDigest = hash(JSON.stringify(receipt.result));
  }],
  ['local receipt substituted with the original Session envelope', f => {
    const receipt = f.state.receipts[0]!; receipt.result = f.observed.sequenceReceipts[0]!.result_json;
    receipt.resultDigest = hash(JSON.stringify(receipt.result));
  }],
  ['missing PostgreSQL receipt', f => { f.observed.sequenceReceipts = []; }],
  ['wrong PostgreSQL receipt digest', f => { f.observed.sequenceReceipts[0]!.result_digest = 'wrong'; }],
  ['wrong PostgreSQL receipt sequence', f => { f.observed.sequenceReceipts[0]!.sequence_number = '8'; }],
  ['PostgreSQL receipt with a forged batch and valid canonical digest', f => {
    const receipt = f.observed.sequenceReceipts[0]!; receipt.result_json.batchId = `other.${'x'.repeat(43)}`;
    receipt.result_digest = hash(JSON.stringify({ contract: 'known.sync-sequence-result.v1', result: receipt.result_json }));
  }],
  ['duplicate server mutation', f => { f.observed.serverMutationCount = 2; }],
  ['missing real HTTP observations', f => { f.observed.pushRequests = []; }],
  ['changed HTTP idempotency key', f => { Object.assign(f.observed.pushRequests[2]!, { headers: { 'idempotency-key': 'other' } }); }],
  ['forged HTTP fingerprint', f => { Object.assign(f.observed.pushRequests[2]!, { fingerprint: f.observed.pushRequests[0]!.fingerprint }); }],
  ['Session changed without 401', f => { Object.assign(f.observed.pushRequests[1]!, { responseStatus: 503 }); }],
  ['Session changed after unrelated 401', f => { Object.assign(f.observed.pushRequests[1]!, { responseCode: 'other' }); }],
  ['accepted request did not succeed', f => { Object.assign(f.observed.pushRequests[2]!, { responseStatus: 500 }); }],
  ['missing actual HTTP result', f => { Object.assign(f.observed.pushRequests[2]!, { responseBody: undefined }); }],
  ['missing real PG batch binding', f => { Object.assign(f.observed.pushRequests[2]!, { expectedServerBatchId: undefined }); }],
  ['HTTP result with the request UUID instead of its server batch', f => {
    rewriteFinalResponse(f, result => { result.batchId = 'new.batch'; });
  }],
  ['HTTP result bound to a different idempotency key', f => {
    rewriteFinalResponse(f, result => { result.batchId = `new.${createHmac('sha256', 'test-secret-new')
      .update('known.sync-push.batch.v1\0other-operation').digest('base64url')}`; });
  }],
  ['HTTP result bound to a previous Session', f => {
    Object.assign(f.observed.pushRequests[2]!, { responseBody: f.observed.pushRequests[0]!.responseBody });
  }],
  ['binding evidence for a different Session', f => {
    Object.assign(f.observed.pushRequests[2]!, { expectedServerBatchId: f.observed.pushRequests[0]!.expectedServerBatchId });
  }],
  ['operation content changed on rebind', f => rewriteFinalBody(f, body => body.replace('Wire title', 'Changed title'))],
  ['atomic semantics changed on rebind', f => rewriteFinalBody(f, body => body.replace('"atomic":false', '"atomic":true'))],
  ['operation encoding changed on rebind', f => rewriteFinalBody(f, body => body.replace('https://', 'https:\\/\\/'))],
  ['operation spacing changed on rebind', f => rewriteFinalBody(f, body => body.replace('"sequence":7', '"sequence": 7'))],
  ['same Session with a different batch', f => rewriteFinalBody(f, body => body.replace('"sessionId":"new"', '"sessionId":"old"'))],
  ['a third transport envelope', f => { f.observed.pushRequests.push({ ...f.observed.pushRequests[2]! });
    rewriteFinalBody(f, body => body.replace('new.batch', 'third.batch').replace('"sessionId":"new"', '"sessionId":"third"')); }],
];
test.each(corruptions)('replay evidence rejects %s', (_name, corrupt) => {
  const f = fixture(); corrupt(f);
  expect(() => expectAuthenticatedRestartReplay(f.before, f.state, f.observed)).toThrow();
});

test('same-Session checker rejects a changed body even when its new fingerprint is genuine', () => {
  const f = fixture(false);
  rewriteFinalBody(f, body => `${body} `);
  expect(() => expectSameSessionReplay(f.before, f.state, f.observed)).toThrow();
});

test('terminal success cannot hide a missing retained attempt before an authenticated restart', () => {
  const f = fixture();
  expect(() => expectAuthenticatedRestartReplay({ ...f.before, attempt: undefined }, f.state, f.observed)).toThrow();
  f.after.status = 'blocked';
  expect(() => expectSuccessfulPush(f.before, f.state, f.observed)).toThrow();
});

function rewriteFinalBody(f: Fixture, change: (body: string) => string) {
  const request = f.observed.pushRequests.at(-1)!; const body = change(request.body);
  Object.assign(request, { body, fingerprint: hash(body) });
}
function rewriteFinalResponse(f: Fixture, change: (result: Record<string, unknown>) => void) {
  const request = f.observed.pushRequests.at(-1)!;
  const result = JSON.parse(request.responseBody!) as Record<string, unknown>; change(result);
  Object.assign(request, { responseBody: JSON.stringify(result) });
}
