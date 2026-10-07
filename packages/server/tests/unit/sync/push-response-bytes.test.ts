/**
 * A-16 / SR-17 fixture self-check, plus a cross-module contract that runs in the
 * default unit job: the bytes the backend *route* builds for `sequence_gap` (via
 * `createPublicationProblemDescriptor`, the same function `sendProblem` calls)
 * must be readable by the extension's `parseColpProblem`.
 *
 * The backend-fidelity evidence lives in
 * `tests/integration/sync/sync-push-response-parser-fixture-postgres.integration.test.ts`,
 * which feeds live Fastify/PostgreSQL bytes through the very same helper. The
 * documents built inline here only exercise the helper's own contract (key-set
 * checks, parser dispatch, scenario assertions) and are labelled as such.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPublicationProblemDescriptor } from '@know-n/colp/server';
import {
  CONFLICTED_PUSH_RESPONSE,
  PUSH_PROBLEM_CONTENT_TYPE,
  PUSH_PROBLEM_MEDIA_TYPE,
  PUSH_RESULT_CONTENT_TYPE,
  PUSH_RESULT_MEDIA_TYPE,
  REJECTED_PUSH_RESPONSE,
  SEQUENCE_GAP_PUSH_RESPONSE,
  mediaTypePattern,
  parseSyncPushResponseBytes,
  sequenceGapProblemResponse,
  type RealPushResponse,
} from '../../fixtures/sync/push-response-bytes.js';

const IDENTITY = { opId: 'sr17-op-1', sequence: 1 } as const;

function rejectedBytes(overrides: Partial<RealPushResponse> = {}): RealPushResponse {
  // Helper self-check input: field-for-field the shape declared by
  // REJECTED_PUSH_RESPONSE (backend: terminalNodeIdRejection).
  return {
    status: 200,
    contentType: PUSH_RESULT_CONTENT_TYPE,
    body: JSON.stringify({
      batchId: 'sr17-batch-1',
      results: [{ opId: IDENTITY.opId, sequence: 1, status: 'rejected', code: 'resource_id_unavailable', warnings: [] }],
      serverCursor: 'sync-unchanged',
    }),
    ...overrides,
  };
}

function conflictedBytes(): RealPushResponse {
  return {
    status: 200,
    contentType: PUSH_RESULT_CONTENT_TYPE,
    body: JSON.stringify({
      batchId: 'sr17-batch-2',
      results: [{
        opId: IDENTITY.opId, sequence: 1, status: 'conflicted', targetId: 'sr17-node-1',
        cursor: 'sync-conflict-7', conflictId: 'sr17-conflict-1', warnings: [],
      }],
      serverCursor: 'sync-conflict-7',
    }),
  };
}

test('backend-built sequence_gap bytes are readable by the plugin problem parser', () => {
  const bytes = sequenceGapProblemResponse(4);
  const descriptor = createPublicationProblemDescriptor({
    code: 'sequence_gap', recovery: { expectedSequence: 4 },
  });
  // The fixture constant must equal the production descriptor, not a hand copy.
  assert.equal(descriptor.status, SEQUENCE_GAP_PUSH_RESPONSE.status);
  assert.equal(descriptor.headers['content-type'], SEQUENCE_GAP_PUSH_RESPONSE.mediaType);
  assert.equal(descriptor.problem.type, SEQUENCE_GAP_PUSH_RESPONSE.type);
  assert.equal(descriptor.problem.title, SEQUENCE_GAP_PUSH_RESPONSE.title);
  assert.equal(descriptor.problem.retryable, SEQUENCE_GAP_PUSH_RESPONSE.retryable);
  assert.deepEqual(Object.keys(descriptor.problem).sort(), [...SEQUENCE_GAP_PUSH_RESPONSE.problemKeys].sort());
  assert.deepEqual(JSON.parse(bytes.body as string), JSON.parse(JSON.stringify(descriptor.problem)));

  const parsed = parseSyncPushResponseBytes('sequence_gap', bytes, { opId: 'sr17-op-1', sequence: 2 },
    { expectedSequence: 4 });
  assert.equal(parsed.mediaType, PUSH_PROBLEM_MEDIA_TYPE);
  assert.equal(parsed.problem?.code, 'sequence_gap');
  assert.equal(parsed.problem?.status, 409);
  assert.equal(parsed.problem?.expectedSequence, 4);
  assert.equal(parsed.problem?.retryable, true);
  assert.equal(parsed.pushResult, undefined);
  assert.equal(parsed.rawBody, bytes.body);
});

test('the helper parses real push-result bytes for the rejected and conflicted scenarios', () => {
  const rejected = parseSyncPushResponseBytes('rejected', rejectedBytes(), IDENTITY);
  assert.equal(rejected.mediaType, PUSH_RESULT_MEDIA_TYPE);
  assert.equal(rejected.pushResult?.terminal, true);
  assert.equal(rejected.pushResult?.result.status, 'rejected');
  assert.equal(rejected.pushResult?.result.code, REJECTED_PUSH_RESPONSE.resultCode);
  assert.equal(rejected.problem, undefined);

  // A raw string body and an already-parsed object must behave identically.
  const conflicted = parseSyncPushResponseBytes('conflicted', {
    status: 200, contentType: 'application/json; charset=utf-8',
    body: JSON.parse(conflictedBytes().body as string) as Record<string, unknown>,
  }, IDENTITY);
  assert.equal(conflicted.pushResult?.terminal, true);
  assert.equal(conflicted.pushResult?.result.status, 'conflicted');
  assert.equal(conflicted.pushResult?.result.conflictId, 'sr17-conflict-1');
  assert.equal(conflicted.document.serverCursor, conflicted.pushResult?.result.cursor);
});

test('the helper rejects responses that do not match the declared scenario', () => {
  // Wrong HTTP layer: status and media type are asserted before the parser sees bytes.
  assert.throws(() => parseSyncPushResponseBytes('rejected', rejectedBytes({ status: 201 }), IDENTITY));
  assert.throws(() => parseSyncPushResponseBytes('rejected',
    rejectedBytes({ contentType: PUSH_PROBLEM_CONTENT_TYPE }), IDENTITY));
  assert.throws(() => parseSyncPushResponseBytes('sequence_gap', rejectedBytes(), IDENTITY),
    /content-type|status/u);
  // Unknown keys are not tolerated: the fixture pins the exact wire key set.
  assert.throws(() => parseSyncPushResponseBytes('rejected', {
    status: 200, contentType: PUSH_RESULT_CONTENT_TYPE,
    body: JSON.stringify({
      batchId: 'sr17-batch-1',
      results: [{ opId: IDENTITY.opId, sequence: 1, status: 'rejected', code: 'resource_id_unavailable', warnings: [] }],
      serverCursor: 'sync-unchanged', unexpected: true,
    }),
  }, IDENTITY), /document keys/u);
  // The helper must surface the real parser's strictness instead of accepting any 200:
  // the key sets below stay legal while the field values are not.
  assert.throws(() => parseSyncPushResponseBytes('rejected', {
    status: 200, contentType: PUSH_RESULT_CONTENT_TYPE,
    body: JSON.stringify({
      batchId: 'sr17-batch-1',
      results: [{ opId: IDENTITY.opId, sequence: 0, status: 'rejected', code: 'resource_id_unavailable', warnings: [] }],
      serverCursor: 'sync-unchanged',
    }),
  }, IDENTITY), /push_response_invalid/u);
  assert.throws(() => parseSyncPushResponseBytes('conflicted', {
    status: 200, contentType: PUSH_RESULT_CONTENT_TYPE,
    body: JSON.stringify({
      batchId: 'sr17-batch-3',
      results: [{ opId: IDENTITY.opId, sequence: 1, status: 'noop', targetId: 'sr17-node-1',
        cursor: 'sync-2', conflictId: 'sr17-conflict-1', warnings: [] }],
      serverCursor: 'sync-2',
    }),
  }, IDENTITY), /push_response_invalid/u);
  // A gap Problem whose key set omits the recovery field is never silently accepted.
  assert.throws(() => parseSyncPushResponseBytes('sequence_gap', {
    status: 409, contentType: PUSH_PROBLEM_CONTENT_TYPE,
    body: JSON.stringify({
      type: `${SEQUENCE_GAP_PUSH_RESPONSE.type}`, title: 'sequence_gap', status: 409,
      code: 'sequence_gap', retryable: true,
    }),
  }, { opId: 'sr17-op-1', sequence: 2 }), /Problem keys/u);
  // Cross-parser confusion must stay impossible in both directions.
  assert.throws(() => parseSyncPushResponseBytes('sequence_gap', {
    status: 409,
    contentType: PUSH_PROBLEM_CONTENT_TYPE,
    body: rejectedBytes().body,
  }, { opId: 'sr17-op-1', sequence: 2 }));
  assert.throws(() => parseSyncPushResponseBytes('conflicted', {
    status: 200, contentType: PUSH_RESULT_CONTENT_TYPE, body: sequenceGapProblemResponse(1).body,
  }, IDENTITY));
});

test('the conflicted fixture shape carries no result code and always pairs cursor with conflictId', () => {
  assert.equal(CONFLICTED_PUSH_RESPONSE.resultCode, undefined);
  assert.equal(CONFLICTED_PUSH_RESPONSE.serverCursor, 'result-cursor');
  assert.deepEqual([...CONFLICTED_PUSH_RESPONSE.resultKeys].sort(),
    ['conflictId', 'cursor', 'opId', 'sequence', 'status', 'targetId', 'warnings']);
  assert.deepEqual([...SEQUENCE_GAP_PUSH_RESPONSE.problemKeys].sort(),
    ['code', 'expectedSequence', 'retryable', 'status', 'title', 'type']);
  assert.equal(SEQUENCE_GAP_PUSH_RESPONSE.mediaType, 'application/problem+json');
});

test('mediaTypePattern matches the real Fastify headers literally (the +json suffix is escaped)', () => {
  // Regression pin: an unescaped `+` in `application/problem+json` means "one or
  // more m" and never matches the live header Fastify sends.
  assert.equal(mediaTypePattern(PUSH_PROBLEM_MEDIA_TYPE).test('application/problem+json; charset=utf-8'), true);
  assert.equal(mediaTypePattern(PUSH_PROBLEM_MEDIA_TYPE).test('application/problem+json'), true);
  assert.equal(mediaTypePattern(PUSH_PROBLEM_MEDIA_TYPE).test('application/problemjson'), false);
  assert.equal(mediaTypePattern(PUSH_RESULT_MEDIA_TYPE).test('application/json; charset=utf-8'), true);
  assert.equal(mediaTypePattern(PUSH_RESULT_MEDIA_TYPE).test('application/json'), true);
  assert.equal(mediaTypePattern(PUSH_RESULT_MEDIA_TYPE).test('application/jsonp'), false);
  assert.equal(mediaTypePattern(PUSH_RESULT_MEDIA_TYPE).test(PUSH_PROBLEM_CONTENT_TYPE), false);
  assert.equal(mediaTypePattern(PUSH_PROBLEM_MEDIA_TYPE).test(PUSH_RESULT_CONTENT_TYPE), false);
  // The pattern is anchored: a header that merely contains the media type fails.
  assert.equal(mediaTypePattern(PUSH_RESULT_MEDIA_TYPE).test('text/plain; application/json'), false);
});
