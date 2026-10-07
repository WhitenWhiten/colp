import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { test } from 'vitest';

interface OpenApiResponse { readonly $ref?: string; readonly headers?: Readonly<Record<string, unknown>> }
interface OpenApiOperation { readonly operationId: string; readonly security: unknown;
  readonly responses: Readonly<Record<string, OpenApiResponse>> }
interface OpenApiDocument {
  readonly info: { readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: {
    readonly responses: Readonly<Record<string, OpenApiResponse>>;
    readonly schemas: Readonly<Record<string, { readonly additionalProperties?: boolean; readonly required?: readonly string[];
      readonly type?: string; readonly minLength?: number; readonly maxLength?: number; readonly pattern?: string;
      readonly format?: string }>>;
    readonly parameters: Readonly<Record<string, { readonly schema: { readonly maxLength?: number; readonly maximum?: number } }>>;
  };
}
interface ProductRoute { readonly method: string; readonly path: string; readonly operationId: string }

test('P5-05 exposes the frozen additive Follow Product contract and generated catalog', () => {
  const api = parse(readFileSync('openapi/product-v1.yaml', 'utf8')) as OpenApiDocument;
  const expected = [
    ['put', '/api/v1/profiles/{profileId}/follow', 'followProfile'],
    ['delete', '/api/v1/profiles/{profileId}/follow', 'unfollowProfile'],
    ['get', '/api/v1/profiles/{profileId}/followers', 'listProfileFollowers'],
    ['head', '/api/v1/profiles/{profileId}/followers', 'headProfileFollowers'],
    ['get', '/api/v1/profiles/{profileId}/following', 'listProfileFollowing'],
    ['head', '/api/v1/profiles/{profileId}/following', 'headProfileFollowing'],
  ] as const;
  for (const [method, path, operationId] of expected) {
    const operation = api.paths[path]?.[method];
    assert.equal(operation?.operationId, operationId, `${method.toUpperCase()} ${path}`);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    for (const response of Object.values(operation.responses)) {
      const resolved = response.$ref
        ? api.components.responses[response.$ref.split('/').at(-1)] : response;
      assert.ok(resolved.headers?.['Cache-Control']);
    }
  }
  for (const name of ['ProfileSummaryDto', 'FollowRelationDto', 'FollowPageDto']) {
    assert.equal(api.components.schemas[name].additionalProperties, false, name);
  }
  assert.deepEqual(api.components.schemas.FollowRelationDto.required,
    ['actorProfileId', 'targetProfileId', 'following', 'changedAt']);
  assert.deepEqual(api.components.schemas.FollowPageDto.required, ['items', 'nextCursor']);
  assert.deepEqual(api.components.schemas.ProfileStableId, {
    type: 'string',
    minLength: 22,
    maxLength: 22,
    pattern: '^[A-Za-z0-9_-]{21}[AQgw]$',
  });
  assert.equal(api.components.parameters.FollowCursor.schema.maxLength, 2048);
  assert.equal(api.components.parameters.FollowLimit.schema.maximum, 100);
  assert.ok(readFileSync('openapi/baselines/product-v1.1.10.0.yaml', 'utf8'));
  const currentBaseline = parse(readFileSync('openapi/baselines/product-v1.1.11.0.yaml', 'utf8')) as OpenApiDocument;
  assert.equal(currentBaseline.info.version, '1.11.0');
  const routes = JSON.parse(readFileSync('generated/openapi/product-v1.routes.json', 'utf8')) as ProductRoute[];
  const client = readFileSync('generated/openapi/product-v1.client.ts', 'utf8');
  for (const operationId of ['followProfile', 'unfollowProfile', 'listProfileFollowers', 'listProfileFollowing']) {
    assert.match(client, new RegExp(operationId));
  }
  for (const [method, path, operationId] of expected) {
    assert.ok(routes.some((route) => route.method === method.toUpperCase()
      && route.path === path && route.operationId === operationId));
  }
});
