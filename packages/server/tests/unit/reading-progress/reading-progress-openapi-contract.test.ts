import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

test('P2B-19 declares authenticated Reading Progress list/item/query/mutation contracts', () => {
  const api = parse(readFileSync(join(process.cwd(), 'openapi/product-v1.yaml'), 'utf8')) as {
    info: { version: string };
    paths: Record<string, Record<string, { operationId: string; security: unknown; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, { additionalProperties?: boolean }> };
  };
  const list = api.paths['/api/v1/reading-progress'].get;
  const item = api.paths['/api/v1/reading-progress/{resourceType}/{resourceId}'];
  assert.deepEqual([list.operationId, item.get.operationId, item.put.operationId, item.delete.operationId],
    ['listReadingProgress', 'getReadingProgress', 'putReadingProgress', 'resetReadingProgress']);
  for (const operation of [list, item.get, item.put, item.delete]) {
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]); assert.ok(operation.responses['401']);
  }
  assert.ok(item.put.responses['412']); assert.ok(item.delete.responses['428']);
  for (const name of ['ReadingProgressView', 'ReadingProgressPage', 'ReadingProgressTargetSummary', 'ReadingProgressUpdate'])
    assert.equal(api.components.schemas[name].additionalProperties, false);
});
