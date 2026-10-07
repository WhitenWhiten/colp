import assert from 'node:assert/strict';
import type { FastifyReply } from 'fastify';
import { describe, test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  DeleteSubtreeLimitError,
  NodeConflictError,
} from '../../../src/modules/collections/index.js';
import {
  mapCollectionMutationError,
  mapProductDatabaseError,
  rethrowCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../../../src/transport/product-command-mapping.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';

interface ReplyCapture {
  status: number | null;
  mediaType: string | null;
  headers: Record<string, string>;
  body: unknown;
}

function captureReply(): { readonly reply: FastifyReply; readonly capture: ReplyCapture } {
  const capture: ReplyCapture = {
    status: null,
    mediaType: null,
    headers: {},
    body: undefined,
  };
  const reply = {
    code(status: number) {
      capture.status = status;
      return this;
    },
    type(mediaType: string) {
      capture.mediaType = mediaType;
      return this;
    },
    header(name: string, value: string) {
      capture.headers[name] = value;
      return this;
    },
    send(body: unknown) {
      capture.body = body;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, capture };
}

function captureProductError(run: () => unknown): ProductHttpError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ProductHttpError);
    return error;
  }
  assert.fail('Expected ProductHttpError');
}

describe('shared Product command receipt mapping', () => {
  test('replay restores the frozen status, media type, stable headers, and bytes', () => {
    const { reply, capture } = captureReply();
    sendProductCommandReceiptOutcome(reply, {
      kind: 'replay',
      status: 201,
      mediaType: 'application/json; charset=utf-8',
      stableHeaders: { Location: '/api/v1/collections/c1', ETag: '"r2"' },
      body: Buffer.from('{"collection":{"id":"c1"}}'),
    });

    assert.equal(capture.status, 201);
    assert.equal(capture.mediaType, 'application/json; charset=utf-8');
    assert.deepEqual(capture.headers, {
      Location: '/api/v1/collections/c1',
      ETag: '"r2"',
    });
    assert.equal(Buffer.isBuffer(capture.body), true);
    assert.equal((capture.body as Buffer).toString(), '{"collection":{"id":"c1"}}');
  });

  for (const testCase of [
    {
      outcome: { kind: 'in_progress', retryAfterSeconds: 7 } as const,
      status: 409,
      code: 'command_in_progress',
      recovery: 'same_request',
      retrySafe: true,
      retryAfter: 7,
      headers: { 'Retry-After': '7' },
    },
    {
      outcome: { kind: 'reused' } as const,
      status: 409,
      code: 'command_id_reused',
      recovery: 'user_action',
      retrySafe: false,
      retryAfter: null,
      headers: {},
    },
    {
      outcome: { kind: 'expired' } as const,
      status: 410,
      code: 'command_result_expired',
      recovery: 'user_action',
      retrySafe: false,
      retryAfter: null,
      headers: {},
    },
  ]) {
    test(`maps ${testCase.outcome.kind} to the frozen Product error`, () => {
      const error = captureProductError(() => {
        sendProductCommandReceiptOutcome(captureReply().reply, testCase.outcome);
      });
      assert.equal(error.statusCode, testCase.status);
      assert.equal(error.productCode, testCase.code);
      assert.equal(error.recovery, testCase.recovery);
      assert.equal(error.sameRequestRetrySafe, testCase.retrySafe);
      assert.equal(error.retryAfterSeconds, testCase.retryAfter);
      assert.deepEqual(error.headers, testCase.headers);
    });
  }
});

describe('shared Product collection error mapping', () => {
  for (const [outcome, status, code, recovery] of [
    ['conceal', 404, 'resource_not_found', 'none'],
    ['deny', 403, 'insufficient_permission', 'user_action'],
  ] as const) {
    test(`maps authorization ${outcome} without exposing its reason`, () => {
      const mapped = mapCollectionMutationError(new CollectionAuthorizationError({
        outcome,
        reasonCategory: 'private_internal_reason',
      }));
      assert.ok(mapped);
      assert.equal(mapped.statusCode, status);
      assert.equal(mapped.productCode, code);
      assert.equal(mapped.recovery, recovery);
      assert.doesNotMatch(mapped.message, /private_internal_reason/);
    });
  }

  for (const precondition of ['resource', 'content'] as const) {
    test(`maps ${precondition} precondition with the current ETag`, () => {
      const mapped = mapCollectionMutationError(new CollectionPreconditionError({
        precondition,
        currentEtag: '"current"',
      }));
      assert.ok(mapped);
      assert.equal(mapped.statusCode, 412);
      assert.equal(mapped.productCode, 'precondition_failed');
      assert.equal(mapped.precondition, precondition);
      assert.equal(mapped.currentEtag, '"current"');
      assert.equal(mapped.recovery, 'refresh_and_retry');
    });
  }

  for (const [code, recovery] of [
    ['root_immutable', 'none'],
    ['folder_not_empty', 'user_action'],
    ['revision_conflict', 'refresh_and_retry'],
    ['position_context_stale', 'refresh_and_retry'],
  ] as const) {
    test(`maps node conflict ${code} without changing its Product code`, () => {
      const mapped = mapCollectionMutationError(new NodeConflictError(code));
      assert.ok(mapped);
      assert.equal(mapped.statusCode, 409);
      assert.equal(mapped.productCode, code);
      assert.equal(mapped.recovery, recovery);
    });
  }

  test('maps bounded recursive-delete refusal to payload_too_large', () => {
    const mapped = mapCollectionMutationError(new DeleteSubtreeLimitError());
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 413);
    assert.equal(mapped.productCode, 'payload_too_large');
  });

  test('preserves validation field details', () => {
    const mapped = mapCollectionMutationError(new CollectionsError(
      'invalid_node_url',
      'Only absolute HTTP URLs are accepted.',
    ));
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 422);
    assert.equal(mapped.productCode, 'invalid_document');
    assert.deepEqual(mapped.fieldErrors, [{
      path: '/url',
      code: 'invalid_node_url',
      message: 'Only absolute HTTP URLs are accepted.',
    }]);
  });

  test('leaves unknown errors unmapped and rethrows the same object', () => {
    const original = new Error('outside the Product mapping contract');
    assert.equal(mapCollectionMutationError(original), null);
    assert.throws(
      () => rethrowCollectionMutationError(original, 'node-delete'),
      (error: unknown) => error === original,
    );
  });

  test('endpoint profiles rethrow out-of-profile domain errors unchanged', () => {
    const cases = [
      [new CollectionAuthorizationError({ outcome: 'deny', reasonCategory: 'test' }), 'collection-create'],
      [new CollectionPreconditionError({ precondition: 'resource', currentEtag: '"current"' }), 'node-create'],
      [new NodeConflictError('revision_conflict'), 'collection-update'],
      [new DeleteSubtreeLimitError(), 'node-update-or-move'],
    ] as const;

    for (const [original, profile] of cases) {
      assert.throws(
        () => rethrowCollectionMutationError(original, profile),
        (error: unknown) => error === original,
      );
    }
  });

  test('maps only the named publication slug constraint to a stable conflict', () => {
    const conflict = new DatabaseOperationError('unique_violation', {
      code: '23505',
      constraint: 'collections_publication_slug_unique',
      detail: 'Key (publication_slug)=(private-value) already exists.',
    });
    const mapped = captureProductError(() => {
      rethrowCollectionMutationError(conflict, 'collection-update');
    });
    assert.equal(mapped.statusCode, 409);
    assert.equal(mapped.productCode, 'publication_slug_conflict');
    assert.equal(mapped.recovery, 'user_action');
    assert.doesNotMatch(mapped.message, /private-value|constraint|database/iu);

    for (const constraint of ['accounts_email_unique', null] as const) {
      const unrelated = new DatabaseOperationError('unique_violation', {
        code: '23505',
        ...(constraint ? { constraint } : {}),
      });
      assert.throws(
        () => rethrowCollectionMutationError(unrelated, 'collection-update'),
        (error: unknown) => error === unrelated,
      );
    }
  });
});

describe('shared Product database error mapping', () => {
  for (const kind of [
    'serialization_failure',
    'deadlock',
    'lock_timeout',
    'unavailable',
  ] as const) {
    test(`maps retryable ${kind} to the same 503 contract`, () => {
      const mapped = mapProductDatabaseError(new DatabaseOperationError(
        kind,
        new Error('driver detail'),
      ));
      assert.equal(mapped.statusCode, 503);
      assert.equal(mapped.productCode, 'feature_temporarily_unavailable');
      assert.equal(mapped.sameRequestRetrySafe, true);
      assert.equal(mapped.retryAfterSeconds, 1);
      assert.deepEqual(mapped.headers, { 'Retry-After': '1' });
      assert.doesNotMatch(mapped.message, /driver detail/);
    });
  }

  test('keeps uncertain commit outcomes generic and not replay safe', () => {
    const mapped = mapProductDatabaseError(new DatabaseOperationError(
      'commit_outcome_unknown',
      new Error('driver detail'),
    ));
    assert.equal(mapped.statusCode, 500);
    assert.equal(mapped.productCode, 'internal_error');
    assert.equal(mapped.sameRequestRetrySafe, false);
  });
});
