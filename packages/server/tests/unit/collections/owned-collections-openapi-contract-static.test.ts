import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

const backend = join(import.meta.dirname, '../../..');
interface SchemaProperty {
  readonly $ref?: string;
  readonly maxItems?: number;
  readonly type?: string;
  readonly minimum?: number;
}
interface OpenApiDocument {
  readonly info: { readonly version: string };
  readonly paths: Record<string, { readonly get: {
    readonly operationId: string; readonly security: unknown;
    readonly parameters: ReadonlyArray<{ readonly $ref: string }>;
    readonly responses: Record<string, { readonly $ref?: string; readonly headers?: Record<string, { readonly $ref: string }>;
      readonly content?: { readonly 'application/json': { readonly schema: { readonly $ref: string } } } }>;
  } }>;
  readonly components: { readonly schemas: Record<string, {
    readonly additionalProperties: boolean; readonly required: readonly string[];
    readonly properties: Record<string, SchemaProperty>;
  }> };
}

test('current Product contract preserves the authenticated owned Collection page additively', () => {
  const document = parse(readFileSync(join(backend, 'openapi/product-v1.yaml'), 'utf8')) as OpenApiDocument;
  const operation = document.paths['/api/v1/collections']!.get;
  assert.equal(operation.operationId, 'listOwnedCollections');
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.deepEqual(operation.parameters.map((item: { $ref: string }) => item.$ref), [
    '#/components/parameters/OwnedCollectionKind',
    '#/components/parameters/OwnedCollectionVisibility',
    '#/components/parameters/OwnedCollectionLimit',
    '#/components/parameters/OwnedCollectionCursor',
    '#/components/parameters/AcceptJson',
  ]);
  assert.equal(operation.responses['200']!.content!['application/json'].schema.$ref,
    '#/components/schemas/OwnedCollectionPage');
  for (const status of ['200', '400', '401', '406', '429', '500', '503']) {
    const response = operation.responses[status];
    assert.ok(response);
    if (response.$ref) continue;
    assert.equal(response.headers?.['Cache-Control']?.$ref, '#/components/headers/PrivateNoStore');
  }
  const item = document.components.schemas.OwnedCollectionListItem!;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['collection', 'capabilities']);
  assert.equal(item.properties.collection?.$ref, '#/components/schemas/CollectionView');
  assert.equal(item.properties.capabilities?.$ref, '#/components/schemas/CollectionCapabilities');
  assert.equal(Object.hasOwn(item.properties, 'bookmarkCount'), true);
  assert.equal(item.properties.bookmarkCount?.type, 'integer');
  assert.equal(item.properties.bookmarkCount?.minimum, 0);
  assert.equal(item.required.includes('bookmarkCount'), false);
  const collectionView = document.components.schemas.CollectionView!;
  assert.equal(Object.hasOwn(collectionView.properties, 'bookmarkCount'), false);
  const page = document.components.schemas.OwnedCollectionPage!;
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(page.required, ['items', 'page']);
  assert.equal(page.properties.items?.maxItems, 100);
  assert.equal(page.properties.page?.$ref, '#/components/schemas/OwnedCollectionPageState');
});

test('1.21 baseline remains frozen and the current breaking gate follows the generated bundle version', () => {
  const generated = parse(readFileSync(join(backend, 'generated/openapi/product-v1.bundle.yaml'), 'utf8')) as {
    info: { version: string };
  };
  assert.equal(
    existsSync(join(backend, `openapi/baselines/product-v1.${generated.info.version}.yaml`)),
    true,
  );
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.31.0.yaml'), 'utf8')
    .includes('version: 1.31.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.30.0.yaml'), 'utf8')
    .includes('version: 1.30.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.29.0.yaml'), 'utf8')
    .includes('version: 1.29.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.28.0.yaml'), 'utf8')
    .includes('version: 1.28.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.27.0.yaml'), 'utf8')
    .includes('version: 1.27.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.26.0.yaml'), 'utf8')
    .includes('version: 1.26.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.25.0.yaml'), 'utf8')
    .includes('version: 1.25.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.24.0.yaml'), 'utf8')
    .includes('version: 1.24.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.23.0.yaml'), 'utf8')
    .includes('version: 1.23.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.22.0.yaml'), 'utf8')
    .includes('version: 1.22.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.21.0.yaml'), 'utf8')
    .includes('version: 1.21.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.20.0.yaml'), 'utf8')
    .includes('version: 1.20.0'), true);
  assert.equal(readFileSync(join(backend, 'openapi/baselines/product-v1.1.19.0.yaml'), 'utf8')
    .includes('version: 1.19.0'), true);
  const sample = readFileSync(join(backend, 'tests/fixtures/openapi/generated-client-types.ts'), 'utf8');
  assert.match(sample, /OwnedCollectionPage/);
  assert.match(sample, /operations\['listOwnedCollections'\]/);
});
