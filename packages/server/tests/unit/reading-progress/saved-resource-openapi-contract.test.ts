import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

interface Operation {
  operationId: string;
  security: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
}
interface ApiDocument {
  info: { version: string };
  paths: Record<string, { get: Operation; put: Operation; delete: Operation }>;
  components: { schemas: Record<string, { additionalProperties?: boolean; enum?: string[] }> };
}
const api = () => parse(readFileSync(join(process.cwd(), 'openapi/product-v1.yaml'), 'utf8')) as ApiDocument;
test('P2B-16 declares authenticated Saved Resource list, PUT and DELETE contracts', () => {
  const document = api();
  const list = document.paths['/api/v1/saved-resources'].get;
  const item = document.paths['/api/v1/saved-resources/{resourceType}/{resourceId}'];
  assert.deepEqual([list.operationId, item.put.operationId, item.delete.operationId],
    ['listSavedResources', 'saveResource', 'unsaveResource']);
  for (const operation of [list, item.put, item.delete]) {
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    assert.ok(operation.responses['401']);
  }
  for (const name of ['SavedResourceView', 'SavedResourcePage', 'SavedResourceTargetSummary']) {
    assert.equal(document.components.schemas[name].additionalProperties, false);
  }
  assert.deepEqual(document.components.schemas.SavedResourceTargetAvailability.enum, ['available', 'unavailable']);
});
