import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { test } from 'vitest';

type RecordValue = Record<string, unknown>;
interface Operation extends RecordValue {
  operationId: string;
  security: unknown;
  parameters: readonly { $ref: string }[];
  responses: Record<string, { $ref?: string; headers?: Record<string, { $ref?: string }>; content?: Record<string, RecordValue> }>;
  'x-known-route-manifest'?: boolean;
}
interface Document {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, RecordValue>; parameters: Record<string, RecordValue> };
}

const backendRoot = resolve(import.meta.dirname, '../../..');
const FEED_ITEM_REQUIRED = ['feedItemId', 'kind', 'actor', 'collectionId', 'publishedAt'];
const FEED_ITEM_LOCATORS = ['collectionTitle', 'publicationSlug', 'summary'];
const FEED_ITEM_OPTIONAL = [...FEED_ITEM_LOCATORS, 'hiddenPublic'];

test('P5-13 exposes a private current-authorized Feed contract outside the Product Manifest', () => {
  const api = parse(readFileSync('openapi/product-v1.yaml', 'utf8')) as Document;
  const path = api.paths['/api/v1/feed'];
  assert.ok(path);
  for (const [method, operationId] of [['get', 'getProductFeed'], ['head', 'headProductFeed']] as const) {
    const operation = path[method]!;
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    assert.equal(operation['x-known-route-manifest'], false);
    assert.deepEqual(operation.parameters.map((parameter) => parameter.$ref).sort(), [
      '#/components/parameters/FeedCursor', '#/components/parameters/FeedKind',
      '#/components/parameters/FeedLimit',
    ]);
    assert.deepEqual(Object.keys(operation.responses).sort(), ['200', '400', '401', '429', '500', '503']);
    const ok = operation.responses['200']!;
    assert.equal(ok.headers?.['Cache-Control']?.$ref, '#/components/headers/PrivateNoStore');
    assert.ok(ok.headers?.['Content-Length']);
    if (method === 'get') assert.equal(ok.content?.['application/json']?.schema &&
      (ok.content['application/json'].schema as RecordValue).$ref, '#/components/schemas/FeedPageDto');
    else assert.equal(ok.content, undefined);
  }
  for (const schemaName of ['FeedProfileSummaryDto', 'FeedPageDto']) {
    const schema = api.components.schemas[schemaName]!;
    assert.equal(schema.additionalProperties, false, schemaName);
    assert.deepEqual(new Set(schema.required as string[]),
      new Set(Object.keys(schema.properties as RecordValue)), schemaName);
  }
  const item = api.components.schemas.FeedItemDto!;
  assert.equal(item.additionalProperties, false, 'FeedItemDto');
  assert.deepEqual(item.required, FEED_ITEM_REQUIRED);
  const properties = item.properties as RecordValue;
  assert.deepEqual(Object.keys(properties).sort(), [...FEED_ITEM_REQUIRED, ...FEED_ITEM_OPTIONAL].sort());
  for (const name of FEED_ITEM_OPTIONAL) {
    assert.equal(Object.hasOwn(properties, name), true, name);
    assert.equal((item.required as string[]).includes(name), false, name);
  }
  for (const name of FEED_ITEM_LOCATORS) {
    assert.ok(Array.isArray((properties[name] as RecordValue)?.oneOf), name);
  }
  assert.equal((properties.hiddenPublic as RecordValue)?.type, 'boolean');
  assert.match(String((properties.summary as RecordValue)?.description), /public_collection_updated/u);
  assert.match(String((properties.summary as RecordValue)?.description), /new_follower/u);
  assert.doesNotMatch(String((properties.summary as RecordValue)?.description), /first-period/iu);
  assert.equal(Object.hasOwn(properties.summary as RecordValue, 'enum'), false);
  assert.equal((api.components.parameters.FeedCursor!.schema as RecordValue).maxLength, 2048);
  assert.equal((api.components.parameters.FeedLimit!.schema as RecordValue).maximum, 100);
  const routes = readFileSync('generated/openapi/product-v1.routes.json', 'utf8');
  assert.doesNotMatch(routes, /ProductFeed|\/api\/v1\/feed/u);
  // FIX-H-004: the frozen Phase 5 /me Feed alias is excluded from the Product
  // route manifest together with the successor Feed surface.
  const meFeed = api.paths['/api/v1/me/feed'];
  assert.ok(meFeed);
  assert.equal(meFeed.get!.operationId, 'listMyFeed');
  assert.equal(meFeed.get!['x-known-route-manifest'], false);
  assert.deepEqual(meFeed.get!.parameters.map((parameter) => parameter.$ref).sort(), [
    '#/components/parameters/FeedCursor', '#/components/parameters/FeedKind',
    '#/components/parameters/FeedLimit',
  ]);
  assert.equal((meFeed.get!.responses['200']!.content!['application/json']!.schema as RecordValue).$ref,
    '#/components/schemas/FeedPageDto');
  assert.equal(meFeed.head!.operationId, 'headListMyFeed');
  assert.equal(meFeed.head!['x-known-route-manifest'], false);
  const excluded = Object.entries(api.paths).flatMap(([route, pathItem]) => Object.entries(pathItem)
    .filter(([, operation]) => operation['x-known-route-manifest'] === false)
    .map(([method]) => `${method.toUpperCase()} ${route}`));
  assert.deepEqual(excluded.sort(),
    ['GET /api/v1/feed', 'GET /api/v1/me/feed', 'HEAD /api/v1/feed', 'HEAD /api/v1/me/feed']);
  const client = readFileSync('generated/openapi/product-v1.client.ts', 'utf8');
  assert.match(client, /createProductFeedClient/u);
  assert.match(client, /getProductFeed/u);
  assert.match(client, /myFeed/u);
});

test('breaking gate rejects deletion of the Product Feed path', () => {
  const result = spawnSync(process.execPath, ['scripts/check-openapi-breaking.mjs',
    '--baseline', 'tests/fixtures/openapi/breaking/feed-baseline.yaml',
    '--candidate', 'tests/fixtures/openapi/breaking/feed-deleted-path.yaml'], {
    cwd: backendRoot, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /Path removed: \/api\/v1\/feed/u);
});

test('1.23.0 baseline stays additive against the 1.24.0 Feed locator fields', () => {
  const result = spawnSync(process.execPath, ['scripts/check-openapi-breaking.mjs',
    '--baseline', 'openapi/baselines/product-v1.1.23.0.yaml',
    '--candidate', 'openapi/baselines/product-v1.1.24.0.yaml'], {
    cwd: backendRoot, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('requiring FeedItemDto locator fields breaks the 1.23.0 client contract', () => {
  const document = parse(readFileSync(join(backendRoot, 'openapi/product-v1.yaml'), 'utf8')) as Document;
  const item = document.components.schemas.FeedItemDto!;
  item.required = [...FEED_ITEM_REQUIRED, ...FEED_ITEM_OPTIONAL];
  const tempRoot = mkdtempSync(join(tmpdir(), 'known-feeditem-required-'));
  const candidate = join(tempRoot, 'candidate.yaml');
  try {
    writeFileSync(candidate, stringify(document), 'utf8');
    const result = spawnSync(process.execPath, ['scripts/check-openapi-breaking.mjs',
      '--baseline', join(backendRoot, 'openapi/baselines/product-v1.1.23.0.yaml'),
      '--candidate', candidate], { cwd: backendRoot, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'FeedItemDto locator fields in required[] must fail the 1.23.0 additive check');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
