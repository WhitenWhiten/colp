import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { test } from 'vitest';

test('P2B-24 declares additive Search Product operation, union, paging, cache and errors', () => {
  interface Ref { readonly $ref: string }
  interface Schema { readonly additionalProperties?: boolean; readonly required?: readonly string[];
    readonly oneOf?: readonly Ref[]; readonly maxLength?: number; readonly maxItems?: number;
    readonly maximum?: number }
  interface Parameter { readonly schema: Schema; readonly explode?: boolean }
  interface Operation { readonly operationId: string; readonly description?: string; readonly security: unknown;
    readonly parameters: readonly Ref[];
    readonly responses: Readonly<Record<string, { readonly description?: string;
      readonly headers?: Readonly<Record<string, unknown>> }>> }
  const api = parse(readFileSync('openapi/product-v1.yaml', 'utf8')) as {
    readonly info: { readonly version: string };
    readonly paths: { readonly '/api/v1/search': { readonly get: Operation; readonly head: Operation } };
    readonly components: { readonly schemas: Readonly<Record<string, Schema>>;
      readonly parameters: Readonly<Record<string, Parameter>> };
  };
  const operation = api.paths['/api/v1/search'].get;
  assert.equal(operation.operationId, 'searchResources');
  assert.deepEqual(operation.security, [{}, { cookieAuth: [] }, { productBearer: [] }]);
  assert.deepEqual(operation.parameters.map((parameter) => parameter.$ref), [
    '#/components/parameters/SearchQuery', '#/components/parameters/SearchType',
    '#/components/parameters/SearchCursor', '#/components/parameters/SearchLimit',
    '#/components/parameters/SearchAccept',
    '#/components/parameters/IfNoneMatch',
  ]);
  const head = api.paths['/api/v1/search'].head;
  assert.equal(head.operationId, 'headSearchResources');
  assert.deepEqual(head.security, operation.security);
  assert.deepEqual(head.parameters, operation.parameters);
  assert.deepEqual(Object.keys(head.responses).sort(), Object.keys(operation.responses).sort());
  for (const status of ['200', '304', '400', '401', '406', '429', '500', '503']) {
    assert.ok(operation.responses[status], status);
  }
  const ok = operation.responses['200'];
  for (const header of ['Cache-Control', 'Content-Length', 'ETag', 'Vary', 'X-Content-Type-Options', 'X-Request-Id']) {
    assert.ok(ok.headers[header], header);
  }
  assert.match(String(operation.description),
    /Conditional requests still execute the current authority projection before returning 304/u);
  assert.match(String(operation.description), /omit ETag and never[\s\S]{0,40}304/u);
  assert.match(String(operation.description), /does not omit candidate SQL/u);
  assert.match(String(operation.description), /ETag applies to anonymous shared-cache validators only/u);
  assert.match(String(head.description), /does not skip origin candidate SQL/u);
  assert.match(String(head.description), /authenticated HEAD omits ETag and never[\s\S]{0,20}304/u);
  assert.match(String(operation.responses['304']?.description), /Anonymous only/u);
  assert.match(String(operation.responses['304']?.description), /fresh origin search/u);
  assert.match(String(head.responses['304']?.description), /Authenticated Session requests never receive 304/u);
  const page = api.components.schemas.SearchPage!;
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(page.required, ['query', 'types', 'items', 'page', 'consistency']);
  const union = api.components.schemas.SearchResult!.oneOf;
  assert.deepEqual(union?.map((entry) => entry.$ref), [
    '#/components/schemas/SearchCollectionResult', '#/components/schemas/SearchNodeResult',
    '#/components/schemas/SearchProfileResult', '#/components/schemas/SearchAnnotationResult',
  ]);
  for (const name of ['SearchCollectionResult', 'SearchNodeResult', 'SearchProfileResult',
    'SearchAnnotationResult', 'SearchPageState', 'SearchConsistency']) {
    assert.equal(api.components.schemas[name]!.additionalProperties, false, name);
  }
  assert.equal(api.components.parameters.SearchQuery!.schema.maxLength, 512);
  assert.equal(api.components.parameters.SearchType!.explode, true);
  assert.equal(api.components.parameters.SearchType!.schema.maxItems, 4);
  assert.equal(api.components.parameters.SearchCursor!.schema.maxLength, 2048);
  assert.equal(api.components.parameters.SearchLimit!.schema.maximum, 100);
});

test('P2B-24 preserves immutable 1.6 baseline and registers Search in generated catalog', () => {
  assert.doesNotThrow(() => readFileSync('openapi/baselines/product-v1.1.6.0.yaml', 'utf8'));
  const routes = JSON.parse(readFileSync('generated/openapi/product-v1.routes.json', 'utf8')) as
    Array<{ method: string; path: string; operationId: string }>;
  assert.ok(routes.some((route) => route.method === 'GET' && route.path === '/api/v1/search'
    && route.operationId === 'searchResources'));
  assert.ok(routes.some((route) => route.method === 'HEAD' && route.path === '/api/v1/search'
    && route.operationId === 'headSearchResources'));
});
