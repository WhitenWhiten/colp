import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { httpCommandScopeV1 } from '../../../src/transport/http-command-scope.js';
import {
  CREATE_OWNED_COLLECTION_COMMAND_SCOPE,
  createCollectionNodeCommandScope,
  deleteCollectionNodeCommandScope,
  moveCollectionNodeCommandScope,
  updateCollectionMetadataCommandScope,
  updateCollectionNodeCommandScope,
} from '../../../src/modules/collections/index.js';

describe('HTTP command scope v1', () => {
  test('preserves all stored pre-layering receipt keys byte for byte', () => {
    const cases = [
      ['POST', '/api/v1/collections', 'POST /api/v1/collections'],
      [
        'PATCH',
        '/api/v1/collections/collection-1',
        'PATCH /api/v1/collections/collection-1',
      ],
      [
        'POST',
        '/api/v1/collections/collection-1/nodes',
        'POST /api/v1/collections/collection-1/nodes',
      ],
      [
        'PATCH',
        '/api/v1/collections/collection-1/nodes/node-1',
        'PATCH /api/v1/collections/collection-1/nodes/node-1',
      ],
      [
        'POST',
        '/api/v1/collections/collection-1/nodes/node-1/move',
        'POST /api/v1/collections/collection-1/nodes/node-1/move',
      ],
      [
        'DELETE',
        '/api/v1/collections/collection-1/nodes/node-1',
        'DELETE /api/v1/collections/collection-1/nodes/node-1',
      ],
    ] as const;

    const scopes = cases.map(([method, path, expected]) => {
      const scope = httpCommandScopeV1(method, path);
      assert.equal(scope, expected);
      return scope;
    });
    assert.equal(new Set(scopes).size, cases.length);
  });

  test('keeps different resources in distinct receipt namespaces', () => {
    const cases = [
      ['PATCH', '/api/v1/collections/collection-1', '/api/v1/collections/collection-2'],
      [
        'POST',
        '/api/v1/collections/collection-1/nodes',
        '/api/v1/collections/collection-2/nodes',
      ],
      [
        'PATCH',
        '/api/v1/collections/collection-1/nodes/node-1',
        '/api/v1/collections/collection-1/nodes/node-2',
      ],
      [
        'POST',
        '/api/v1/collections/collection-1/nodes/node-1/move',
        '/api/v1/collections/collection-1/nodes/node-2/move',
      ],
      [
        'DELETE',
        '/api/v1/collections/collection-1/nodes/node-1',
        '/api/v1/collections/collection-1/nodes/node-2',
      ],
    ] as const;

    for (const [method, firstPath, secondPath] of cases) {
      assert.notEqual(httpCommandScopeV1(method, firstPath), httpCommandScopeV1(method, secondPath));
    }
  });

  test('application command defaults express transport-neutral intent', () => {
    assert.equal(CREATE_OWNED_COLLECTION_COMMAND_SCOPE, 'collection:create');
    assert.equal(createCollectionNodeCommandScope('c1'), 'collection:c1:node:create');
    assert.equal(updateCollectionMetadataCommandScope('c1'), 'collection:c1:metadata:update');
    assert.equal(updateCollectionNodeCommandScope('c1', 'n1'), 'collection:c1:node:n1:update');
    assert.equal(moveCollectionNodeCommandScope('c1', 'n1'), 'collection:c1:node:n1:move');
    assert.equal(deleteCollectionNodeCommandScope('c1', 'n1'), 'collection:c1:node:n1:delete');
  });
});
