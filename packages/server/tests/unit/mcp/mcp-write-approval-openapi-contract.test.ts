import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import YAML from 'yaml';

interface Parameter {
  readonly name?: string;
  readonly $ref?: string;
}

interface Operation {
  readonly operationId: string;
  readonly security?: readonly Record<string, readonly unknown[]>[];
  readonly parameters: readonly Parameter[];
  readonly requestBody?: { readonly required?: boolean };
  readonly responses: Readonly<Record<string, unknown>>;
}

interface Contract {
  readonly info: { readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: {
    readonly parameters: Readonly<Record<string, { readonly name: string }>>;
    readonly schemas: Readonly<Record<string, {
      readonly additionalProperties?: boolean;
      readonly enum?: readonly string[];
      readonly properties?: Readonly<Record<string, { readonly enum?: readonly string[] }>>;
      readonly required?: readonly string[];
    }>>;
  };
}

const source = YAML.parse(readFileSync('openapi/product-v1.yaml', 'utf8')) as Contract;

function parameterNames(operation: Operation): Array<string | undefined> {
  return operation.parameters.map((parameter) => {
    if (parameter.name !== undefined) return parameter.name;
    const name = parameter.$ref?.split('/').at(-1);
    return name === undefined ? undefined : source.components.parameters[name]?.name;
  });
}

test('Write approval Product contract exposes list, item, and decision operations', () => {
  assert.ok(source.paths['/api/v1/mcp/approvals']?.get);
  assert.ok(source.paths['/api/v1/mcp/approvals/{planId}']?.get);
  assert.ok(source.paths['/api/v1/mcp/approvals/{planId}/decision']?.post);
  assert.equal(source.paths['/api/v1/mcp/approvals'].get.operationId, 'listWriteApprovals');
  assert.equal(source.paths['/api/v1/mcp/approvals/{planId}'].get.operationId, 'getWriteApproval');
  assert.equal(
    source.paths['/api/v1/mcp/approvals/{planId}/decision'].post.operationId,
    'decideWriteApproval',
  );
});

test('Write approval schemas are closed and expose only safe structural previews', () => {
  for (const name of ['WriteApprovalView', 'WriteApprovalPage', 'WriteApprovalDecisionRequest',
    'WriteApprovalDecisionResult', 'WriteApprovalOperationPreview']) {
    const schema = source.components.schemas[name];
    assert.ok(schema, `missing schema ${name}`);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      new Set(schema.required ?? []),
      new Set(Object.keys(schema.properties ?? {})),
      `${name} required/property drift`,
    );
  }
  assert.deepEqual(
    source.components.schemas.WriteApprovalStatus?.enum,
    ['pending', 'approved', 'committing', 'consumed', 'cancelled', 'expired'],
  );
  assert.deepEqual(
    source.components.schemas.WriteApprovalDecision?.enum,
    ['approve', 'deny'],
  );
  assert.equal(
    (
      source.components.schemas.WriteApprovalDecisionRequest?.properties?.decision as
        Readonly<{ readonly $ref?: string }> | undefined
    )?.$ref,
    '#/components/schemas/WriteApprovalDecision',
  );
  const view = source.components.schemas.WriteApprovalView?.properties ?? {};
  for (const name of ['planId', 'status', 'risk', 'requiresApproval', 'summary', 'impact',
    'requiredScopes', 'target', 'operations', 'createdAt', 'expiresAt', 'decision', 'etag']) {
    assert.ok(view[name], `WriteApprovalView.${name}`);
  }
  const nodeSummary = source.components.schemas.WriteApprovalOperationPreview?.properties?.nodeSummary;
  assert.ok(nodeSummary);
  assert.ok(
    (nodeSummary as { oneOf?: unknown }).oneOf !== undefined
    || (nodeSummary as { $ref?: unknown }).$ref !== undefined,
  );
  assert.ok(source.components.schemas.WriteApprovalOperationPreview?.properties?.type);
  assert.ok(source.components.schemas.WriteApprovalOperationPreview?.properties?.collectionId);
  assert.ok(source.components.schemas.WriteApprovalOperationPreview?.properties?.nodeId);
  assert.ok(source.components.schemas.WriteApprovalOperationPreview?.properties?.visibility);
});

test('Write approval mutations declare authenticated command, CSRF, Origin, and strong precondition headers', () => {
  const list = source.paths['/api/v1/mcp/approvals'].get;
  const item = source.paths['/api/v1/mcp/approvals/{planId}'].get;
  const decision = source.paths['/api/v1/mcp/approvals/{planId}/decision'].post;
  for (const operation of [list, item, decision]) {
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
    assert.ok(operation.responses['500']);
    assert.ok(operation.responses['503']);
  }
  const decisionNames = parameterNames(decision);
  for (const name of ['planId', 'Origin', 'X-CSRF-Token', 'Known-Command-Id', 'If-Match']) {
    assert.ok(decisionNames.includes(name), `decision missing ${name}`);
  }
  assert.equal(decision.requestBody?.required, true);
  for (const status of ['400', '401', '403', '404', '409', '412', '413', '415', '422',
    '428', '429']) {
    assert.ok(decision.responses[status], `decision missing ${status}`);
  }
  assert.equal(
    parameterNames(item).filter((name) => name === 'planId').length,
    1,
  );
});

test('generated approval client and route manifest are source-derived', () => {
  const client = readFileSync('generated/openapi/product-v1.client.ts', 'utf8');
  const routes = JSON.parse(readFileSync('generated/openapi/product-v1.routes.json', 'utf8')) as
    Array<{ readonly operationId: string }>;
  assert.match(client, /createProductWriteApprovalClient/u);
  assert.match(client, /WriteApprovalPage/u);
  assert.match(client, /WriteApprovalView/u);
  assert.match(client, /WriteApprovalDecisionResult/u);
  for (const operationId of ['listWriteApprovals', 'getWriteApproval', 'decideWriteApproval']) {
    assert.ok(routes.some((route) => route.operationId === operationId), operationId);
  }
});
