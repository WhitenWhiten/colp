import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';

describe('P3-36 Product Sync Center generated contract', () => {
  test('publishes the Sync Center and trash Product routes in source, bundle, generated client and manifest', () => {
    const root = new URL('../../../', import.meta.url); const artifacts = ['openapi/product-v1.yaml',
      'generated/openapi/product-v1.bundle.yaml', 'generated/openapi/product-v1.ts', 'generated/openapi/product-v1.routes.json'];
    for (const file of artifacts) { const source = readFileSync(new URL(file, root), 'utf8');
      for (const path of ['/api/v1/sync/status', '/api/v1/sync/conflicts',
        '/api/v1/sync/conflicts/{conflictId}/resolution', '/api/v1/sync/replicas/{replicaId}',
        '/api/v1/sync/trash', '/api/v1/sync/trash/empty', '/api/v1/sync/trash/restore-batch',
        '/api/v1/sync/trash/{deletionId}', '/api/v1/sync/trash/{deletionId}/restore',
        '/api/v1/sync/trash/{deletionId}/restore-subtree']) {
        assert.match(source, new RegExp(path.replace(/[{}]/g, '\\$&')));
      }
      assert.doesNotMatch(source, /\/api\/v1\/sync\/(now|telemetry|queue|roots)/u);
    }
    assert.deepEqual(PRODUCT_ROUTE_MANIFEST.filter((route) => route.path.startsWith('/api/v1/sync/')).map((route) =>
      `${route.method} ${route.path}`), ['GET /api/v1/sync/conflicts', 'POST /api/v1/sync/conflicts/{conflictId}/resolution',
      'DELETE /api/v1/sync/replicas/{replicaId}', 'GET /api/v1/sync/status',
      'GET /api/v1/sync/trash', 'POST /api/v1/sync/trash/empty', 'POST /api/v1/sync/trash/restore-batch',
      'GET /api/v1/sync/trash/{deletionId}', 'POST /api/v1/sync/trash/{deletionId}/restore',
      'POST /api/v1/sync/trash/{deletionId}/restore-subtree']);
  });
});
