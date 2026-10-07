import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { describe, test } from 'vitest';
import {
  readCollectionIdParam,
  readNodeIdParam,
  requireProductCollectionMutationUnitOfWork,
  type CollectionRoutesDeps,
} from '../../../src/transport/product/collection-route-helpers.js';
import { ProductHttpError } from '../../../src/transport/product-error.js';

function assertInvalidRequest(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => (
    error instanceof ProductHttpError
    && error.statusCode === 400
    && error.productCode === 'invalid_request'
  ));
}

describe('collection route helper guards', () => {
  test('fails closed when the canonical mutation unit of work is absent', () => {
    assert.throws(
      () => requireProductCollectionMutationUnitOfWork({} as CollectionRoutesDeps),
      /canonical mutation unit of work is not configured/,
    );
  });

  test('rejects missing and blank collection path parameters', () => {
    assertInvalidRequest(() => readCollectionIdParam({ params: {} } as FastifyRequest));
    assertInvalidRequest(() => readCollectionIdParam({
      params: { collectionId: '   ' },
    } as unknown as FastifyRequest));
  });

  test('rejects missing and blank node path parameters', () => {
    assertInvalidRequest(() => readNodeIdParam({ params: {} } as FastifyRequest));
    assertInvalidRequest(() => readNodeIdParam({
      params: { nodeId: '   ' },
    } as unknown as FastifyRequest));
  });
});
