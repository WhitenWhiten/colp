import type { AnySchema } from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { McpToolInputError } from '../../src/mcp/tool-input.js';
import {
  createMcpWriteToolGateway,
  toRedactedKeyToolResult,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import { collectionProtocolSchema, createAjv } from '../../src/schema/index.js';
import { materializeClosedMcpToolSchema } from '../../src/mcp/schema-ref.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import {
  canonicalApiKeyCreateResultFixture,
  canonicalApiKeyMetadataFixture,
  canonicalApiKeyRotateResultFixture,
} from './canonical-api-key-fixture.js';
import { createCommitCoordinatorFixture } from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

interface PublishedToolDefinition {
  readonly name: string;
  readonly inputSchema: AnySchema;
  readonly outputSchema: AnySchema;
}

interface WriteGateway {
  readonly listTools: () => readonly PublishedToolDefinition[];
  readonly callTool: (
    name: string,
    input: unknown,
    context: McpTrustedWriteRequestContext,
  ) => Promise<Readonly<{ structuredContent?: unknown; isError?: boolean }>>;
  readonly recordOutOfBandApproval: (
    planId: string,
    context: McpTrustedWriteRequestContext,
  ) => Promise<void>;
}

const evidence = '[review:mcp-write.m03]';
const canonicalPrefix = `${collectionProtocolSchema.$id}#/$defs/`;
const context: McpTrustedWriteRequestContext = Object.freeze({
  binding: authenticatedBinding({
    principalId: 'subject-m03',
    clientId: 'client-m03',
  }),
  scope: Object.freeze([
    'access:write',
    'collections:delete',
    'nodes:delete',
    'keys:write',
    'rate_limits:write',
    'release:publish',
    'sync:pull',
    'sync:push',
  ]),
  budget: Object.freeze({ maxDepth: 32, maxNodes: 10_000, maxBytes: 1_048_576, maxOperations: 1_000 }),
  abortSignal: new AbortController().signal,
  authorization: Object.freeze({ principalId: 'subject-m03' }),
});

async function expectToolInputError(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(McpToolInputError);
  expect(caught).toMatchObject({
    name: 'McpToolInputError',
    code: 'invalid_tool_input',
  });
  expect((caught as McpToolInputError).issues.length).toBeGreaterThan(0);
}

const operationCases = Object.freeze([
  {
    type: 'delete_collection',
    missing: 'collectionId',
    operation: { type: 'delete_collection', collectionId: 'collection-1', baseRevision: 'r1' },
  },
  {
    type: 'delete_subtree',
    missing: 'targetId',
    operation: {
      type: 'delete_subtree',
      collectionId: 'collection-1',
      targetId: 'node-1',
      baseRevision: 'r1',
    },
  },
  {
    type: 'set_visibility',
    missing: 'input',
    operation: {
      type: 'set_visibility',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { visibility: 'protected' },
    },
  },
  {
    type: 'set_access_policy',
    missing: 'input',
    operation: {
      type: 'set_access_policy',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { visibility: 'private' },
    },
  },
  {
    type: 'create_key',
    missing: 'input',
    operation: {
      type: 'create_key',
      input: {
        name: 'MCP publisher',
        type: 'publisher_key',
        scopes: ['collections:write'],
        collections: ['collection-1'],
        expiresAt: null,
      },
    },
  },
  {
    type: 'rotate_key',
    missing: 'targetId',
    operation: { type: 'rotate_key', targetId: 'key-1', input: { overlapSeconds: 30 } },
  },
  {
    type: 'revoke_key',
    missing: 'targetId',
    operation: { type: 'revoke_key', targetId: 'key-1' },
  },
  {
    type: 'set_rate_limit',
    missing: 'baseRevision',
    operation: {
      type: 'set_rate_limit',
      targetId: 'principal-1',
      baseRevision: 'r1',
      input: { limit: 100, windowSeconds: 60 },
    },
  },
  {
    type: 'publish_release',
    missing: 'input',
    operation: {
      type: 'publish_release',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { title: 'Release 1' },
    },
  },
  {
    type: 'sync_mirror',
    missing: 'input',
    operation: {
      type: 'sync_mirror',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { replicaId: 'replica-1' },
    },
  },
] satisfies readonly Readonly<{
  type: ChangePlanOperation['type'];
  missing: string;
  operation: ChangePlanOperation;
}>[]);

const createKeyInput = Object.freeze({
  name: 'MCP publisher',
  type: 'publisher_key',
  scopes: Object.freeze(['collections:write']),
  collections: Object.freeze(['collection-1']),
  expiresAt: null,
});
const rotateKeyInput = Object.freeze({ overlapSeconds: 30 });

function impact() {
  return {
    collections: 1,
    nodes: 1,
    annotations: 0,
    attachments: 0,
    relations: 0,
    privateFieldsExcluded: [] as string[],
  };
}

function baseRevisions(operation: ChangePlanOperation): Readonly<Record<string, string>> {
  if (!('baseRevision' in operation)) return Object.freeze({});
  if (operation.type === 'set_access_policy' || operation.type === 'set_visibility') {
    return Object.freeze({ [`access.${operation.collectionId}`]: operation.baseRevision });
  }
  return Object.freeze({ [`m03.${operation.type}`]: operation.baseRevision });
}

function lowRiskTool(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { value: { type: 'integer' } },
      required: ['value'],
    },
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { doubled: { type: 'integer' } },
      required: ['doubled'],
    },
    toCanonicalOperations: () => [{ type: 'custom.write', risk: 'low' as const }],
    invoke: (input: Readonly<Record<string, unknown>>) => ({
      doubled: (input.value as number) * 2,
    }),
    ...overrides,
  };
}

function createGateway(overrides: Readonly<Record<string, unknown>> = {}): WriteGateway {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = {
    execute: vi.fn(async (): Promise<readonly OperationResult[]> => [{
      opId: 'op-m03',
      sequence: 1,
      status: 'applied',
      revision: 'r2',
      cursor: 'cursor-m03',
      warnings: [],
    }]),
  };
  const gateway = createMcpWriteToolGateway({
    changePlan: {
      planStore,
      approvalStore,
      impact: { assessImpact: vi.fn(async () => impact()) },
      revisions: {
        resolveBaseRevisions: vi.fn(async (operation: ChangePlanOperation) =>
          baseRevisions(operation)),
        currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
      },
      scopes: { hasScopes: vi.fn(async () => true) },
      authorizationPolicy: {
        requiredScopesForOperation: vi.fn(async (operation: ChangePlanOperation) =>
          operation.type === 'sync_mirror' ? ['sync:pull', 'sync:push'] as const : []),
      },
      commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
      rateLimit: { allow: vi.fn(async () => true) },
      approvalBaseUri: 'https://host.example/approvals',
      uriPolicy: { allow: () => true },
      ids: { nextPlanId: () => 'plan-m03' },
      clock: { now: () => new Date('2026-07-24T14:00:00.000Z') },
    },
    apiKeys: {
      createKey: vi.fn(async () => canonicalApiKeyCreateResultFixture(
        apiKeyMetadata('key-create-m03'),
        'colp_secret_create_m03',
      )),
      rotateKey: vi.fn(async () => canonicalApiKeyRotateResultFixture(
        apiKeyMetadata('key-rotate-m03'),
        'colp_secret_rotate_m03',
      )),
    },
    revealUriForKey: (keyId: string) => `https://host.example/keys/${keyId}/reveal`,
    ...overrides,
  } as never);
  return gateway as unknown as WriteGateway;
}

function apiKeyMetadata(id: string) {
  return canonicalApiKeyMetadataFixture({
    id,
    name: 'MCP publisher',
    type: 'publisher_key',
    scopes: ['collections:write'],
    collections: ['collection-1'],
    createdAt: '2026-07-24T14:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    status: 'active',
  });
}

function definition(gateway: WriteGateway, name: string): PublishedToolDefinition {
  const found = gateway.listTools().find((candidate) => candidate.name === name);
  expect(found, `${name} must be published`).toBeDefined();
  return found!;
}

function compile(schema: AnySchema) {
  const ajv = createAjv({ ownProperties: true });
  const closed = materializeClosedMcpToolSchema(schema as Record<string, unknown>);
  assertNoCollectionProtocolOrgRef(closed);
  return ajv.compile(closed as AnySchema);
}

function assertNoCollectionProtocolOrgRef(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCollectionProtocolOrgRef(entry);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof child === 'string') {
      expect(child.includes('know-n.com/colp')).toBe(false);
    }
    assertNoCollectionProtocolOrgRef(child);
  }
}

function expectCanonicalReferenceGraph(schema: unknown): void {
  const visit = (candidate: unknown, seen: Set<object>): void => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    expect(candidate).not.toHaveProperty('$defs');
    const reference = Object.getOwnPropertyDescriptor(candidate, '$ref');
    if (reference !== undefined) {
      expect('value' in reference).toBe(true);
      if ('value' in reference) {
        expect(typeof reference.value).toBe('string');
        expect(reference.value).toMatch(new RegExp(`^${escapeRegex(canonicalPrefix)}[^/#?%]+$`, 'u'));
      }
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      expect('value' in descriptor).toBe(true);
      if ('value' in descriptor) visit(descriptor.value, seen);
    }
  };
  visit(schema, new Set<object>());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function dereferenceRoot(schema: AnySchema): AnySchema {
  let current = schema as AnySchema & { readonly $ref?: string };
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    expect(current.$ref.startsWith(canonicalPrefix)).toBe(true);
    expect(seen.has(current.$ref)).toBe(false);
    seen.add(current.$ref);
    const name = current.$ref.slice(canonicalPrefix.length);
    current = collectionProtocolSchema.$defs[name as keyof typeof collectionProtocolSchema.$defs] as AnySchema;
    expect(current, `${name} must resolve in canonical $defs`).toBeDefined();
  }
  return current;
}

function expectClosedRoot(schema: AnySchema): void {
  const root = dereferenceRoot(schema) as AnySchema & {
    readonly type?: unknown;
    readonly additionalProperties?: unknown;
    readonly oneOf?: readonly AnySchema[];
  };
  if (Array.isArray(root.oneOf)) {
    expect(root.oneOf.length).toBeGreaterThan(0);
    for (const branch of root.oneOf) expectClosedRoot(branch);
    return;
  }
  expect(root.type).toBe('object');
  expect(root.additionalProperties).toBe(false);
}

function planRequest(operation: ChangePlanOperation) {
  return { operations: [operation], reason: `M-03 ${operation.type}`, dryRun: true as const };
}

describe(`M-03 published MCP write Tool schemas ${evidence}`, () => {
  it(`compiles every published input/output schema against the canonical graph ${evidence}`, () => {
    const gateway = createGateway({
      lowRiskTools: { 'custom.double': lowRiskTool() },
    });
    expect(gateway.listTools().map(({ name }) => name)).toEqual([
      'changes.plan',
      'changes.commit',
      'changes.cancel',
      'keys.create',
      'keys.rotate',
      'custom.double',
    ]);

    for (const tool of gateway.listTools()) {
      expect(Object.prototype.hasOwnProperty.call(tool, 'inputSchema')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(tool, 'outputSchema')).toBe(true);
      expectCanonicalReferenceGraph(tool.inputSchema);
      expectCanonicalReferenceGraph(tool.outputSchema);
      expect(() => compile(tool.inputSchema)).not.toThrow();
      expect(() => compile(tool.outputSchema)).not.toThrow();
    }
  }, 15_000);

  it(`publishes canonical operation and key request references ${evidence}`, () => {
    const gateway = createGateway();
    const planSchema = definition(gateway, 'changes.plan').inputSchema as {
      readonly properties: { readonly operations: { readonly items: unknown } };
    };
    expect(planSchema.properties.operations.items).toEqual({
      $ref: `${canonicalPrefix}changePlanOperation`,
    });
    expect(definition(gateway, 'keys.create').inputSchema).toEqual({
      $ref: `${canonicalPrefix}apiKeyCreateRequest`,
    });
    expect(definition(gateway, 'keys.rotate').inputSchema).toEqual({
      $ref: `${canonicalPrefix}apiKeyRotateRequest`,
    });
  });

  it.each(operationCases)(
    `keeps schema and runtime acceptance aligned for canonical $type ${evidence}`,
    async ({ operation }) => {
      const gateway = createGateway();
      const request = planRequest(operation);
      const validate = compile(definition(gateway, 'changes.plan').inputSchema);
      expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
      await expect(gateway.callTool('changes.plan', request, context)).resolves.toMatchObject({
        structuredContent: { planId: 'plan-m03' },
      });
    },
  );

  it.each(operationCases)(
    `rejects schema-invalid and runtime-invalid $type operations ${evidence}`,
    async ({ operation, missing }) => {
      const gateway = createGateway();
      const malformed = { ...operation } as Record<string, unknown>;
      delete malformed[missing];
      const request = planRequest(malformed as unknown as ChangePlanOperation);
      const validate = compile(definition(gateway, 'changes.plan').inputSchema);
      expect(validate(request)).toBe(false);
      await expectToolInputError(gateway.callTool('changes.plan', request, context));

      const extraRequest = planRequest(
        { ...operation, unexpected: true } as unknown as ChangePlanOperation,
      );
      expect(validate(extraRequest)).toBe(false);
      await expectToolInputError(gateway.callTool('changes.plan', extraRequest, context));
    },
  );

  it.each([
    {},
    { type: 'unknown_operation' },
    { type: 'delete_collection', collectionId: 'collection-1', baseRevision: 'r1', input: {} },
  ])(`rejects values outside every canonical operation branch: %j ${evidence}`, async (operation) => {
    const gateway = createGateway();
    const request = planRequest(operation as ChangePlanOperation);
    const validate = compile(definition(gateway, 'changes.plan').inputSchema);
    expect(validate(request)).toBe(false);
    await expectToolInputError(gateway.callTool('changes.plan', request, context));
  });

  it(`validates actual Plan, Commit, and Cancel structured output ${evidence}`, async () => {
    const planGateway = createGateway();
    const [firstOperationCase] = operationCases;
    expect(firstOperationCase).toBeDefined();
    if (firstOperationCase === undefined) throw new Error('M-03 operation fixtures are empty.');
    const planInput = planRequest(firstOperationCase.operation);
    const planned = await planGateway.callTool('changes.plan', planInput, context);
    const validatePlan = compile(definition(planGateway, 'changes.plan').outputSchema);
    expect(validatePlan(planned.structuredContent), JSON.stringify(validatePlan.errors)).toBe(true);

    await planGateway.recordOutOfBandApproval('plan-m03', context);
    const committed = await planGateway.callTool(
      'changes.commit',
      { planId: 'plan-m03', idempotencyKey: 'idem-m03' },
      context,
    );
    const validateCommit = compile(definition(planGateway, 'changes.commit').outputSchema);
    expect(validateCommit(committed.structuredContent), JSON.stringify(validateCommit.errors)).toBe(true);

    const cancelGateway = createGateway();
    await cancelGateway.callTool('changes.plan', planInput, context);
    const cancelled = await cancelGateway.callTool('changes.cancel', { planId: 'plan-m03' }, context);
    const validateCancel = compile(definition(cancelGateway, 'changes.cancel').outputSchema);
    expect(validateCancel(cancelled.structuredContent), JSON.stringify(validateCancel.errors)).toBe(true);
  });

  it.each([
    ['keys.create', createKeyInput],
    ['keys.rotate', rotateKeyInput],
  ] as const)(`validates the actual %s requires-Plan output ${evidence}`, async (name, input) => {
    const gateway = createGateway();
    const result = await gateway.callTool(name, input, context);
    expect(result.isError).toBe(true);
    const validate = compile(definition(gateway, name).outputSchema);
    expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  });

  it(`also admits the redacted successful key projection and rejects plaintext secret ${evidence}`, () => {
    const gateway = createGateway();
    for (const [name, keyId] of [
      ['keys.create', 'key-create-m03'],
      ['keys.rotate', 'key-rotate-m03'],
    ] as const) {
      const validate = compile(definition(gateway, name).outputSchema);
      const projected = toRedactedKeyToolResult(
        name === 'keys.create'
          ? canonicalApiKeyCreateResultFixture(
            apiKeyMetadata(keyId),
            `colp_secret_${keyId}`,
          )
          : canonicalApiKeyRotateResultFixture(
            apiKeyMetadata(keyId),
            `colp_secret_${keyId}`,
          ),
        `https://host.example/keys/${keyId}/reveal`,
        { allow: () => true },
      );
      expect(validate(projected), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...projected, secret: 'must-not-be-model-visible' })).toBe(false);
    }
  });

  it.each([
    ['missing inputSchema', { outputSchema: lowRiskTool().outputSchema }],
    ['missing outputSchema', { inputSchema: lowRiskTool().inputSchema }],
    ['open inputSchema', lowRiskTool({
      inputSchema: { type: 'object', additionalProperties: true, properties: {} },
    })],
    ['open outputSchema', lowRiskTool({
      outputSchema: { type: 'object', additionalProperties: true, properties: {} },
    })],
    ['invalid inputSchema', lowRiskTool({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'not-a-json-schema-type' } },
      },
    })],
    ['invalid outputSchema', lowRiskTool({
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { doubled: { $ref: '#/$defs/missing' } },
      },
    })],
  ] as const)(`rejects dynamic registration with %s ${evidence}`, (_label, tool) => {
    expect(() => createGateway({ lowRiskTools: { 'custom.invalid': tool } })).toThrow();
  });

  it(`accepts a 128-character dynamic Tool name and publishes unique names ${evidence}`, () => {
    const boundaryName = `custom.${'a'.repeat(121)}`;
    expect(boundaryName).toHaveLength(128);

    const gateway = createGateway({ lowRiskTools: { [boundaryName]: lowRiskTool() } });
    const publishedNames = gateway.listTools().map(({ name }) => name);

    expect(publishedNames).toContain(boundaryName);
    expect(new Set(publishedNames).size).toBe(publishedNames.length);
  });

  it(`rejects a dynamic Tool name longer than 128 characters during registration ${evidence}`, () => {
    const unreachableName = `custom.${'a'.repeat(122)}`;
    const invoke = vi.fn(() => ({ doubled: 2 }));
    expect(unreachableName).toHaveLength(129);

    expect(() => createGateway({
      lowRiskTools: { [unreachableName]: lowRiskTool({ invoke }) },
    })).toThrow(TypeError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    'changes.plan',
    'changes.commit',
    'changes.cancel',
    'keys.create',
    'keys.rotate',
  ])(`rejects reserved dynamic Tool name %s during registration ${evidence}`, (reservedName) => {
    expect(() => createGateway({
      lowRiskTools: { [reservedName]: lowRiskTool() },
    })).toThrow(TypeError);
  });

  it(`rejects dynamic input before its adapter and invocation ${evidence}`, async () => {
    const toCanonicalOperations = vi.fn(() => [{ type: 'custom.write', risk: 'low' as const }]);
    const invoke = vi.fn(() => ({ doubled: 2 }));
    const gateway = createGateway({
      lowRiskTools: { 'custom.double': lowRiskTool({ toCanonicalOperations, invoke }) },
    });
    await expectToolInputError(
      gateway.callTool('custom.double', { value: '1' }, context),
    );
    expect(toCanonicalOperations).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`returns schema-valid dynamic structured output ${evidence}`, async () => {
    const gateway = createGateway({
      lowRiskTools: { 'custom.double': lowRiskTool() },
    });
    const result = await gateway.callTool('custom.double', { value: 3 }, context);
    const validate = compile(definition(gateway, 'custom.double').outputSchema);
    expect(result).toEqual({ structuredContent: { doubled: 6 } });
    expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  });

  it(`fails closed before returning dynamic output that violates outputSchema ${evidence}`, async () => {
    const invalidOutput = { doubled: '2', modelVisibleLeak: 'must-not-be-returned' };
    const invoke = vi.fn(() => invalidOutput);
    const gateway = createGateway({
      lowRiskTools: { 'custom.double': lowRiskTool({ invoke }) },
    });

    let resolved: unknown;
    let rejection: unknown;
    try {
      resolved = await gateway.callTool('custom.double', { value: 1 }, context);
    } catch (error) {
      rejection = error;
    }
    expect(invoke).toHaveBeenCalledOnce();
    expect(resolved).toBeUndefined();
    expect(rejection).toMatchObject({ code: 'invalid_tool_output' });
    expect(String(rejection)).not.toContain(invalidOutput.modelVisibleLeak);
    expect(JSON.stringify(rejection)).not.toContain(invalidOutput.modelVisibleLeak);
  });

  it(`publishes only closed input and output root schemas ${evidence}`, () => {
    const gateway = createGateway({
      lowRiskTools: { 'custom.double': lowRiskTool() },
    });
    for (const tool of gateway.listTools()) {
      expectClosedRoot(tool.inputSchema);
      expectClosedRoot(tool.outputSchema);
    }
  });

  it(`publishes an immutable snapshot of dynamic schemas ${evidence}`, () => {
    const registration = lowRiskTool();
    const gateway = createGateway({ lowRiskTools: { 'custom.double': registration } });
    const published = definition(gateway, 'custom.double');

    expect(published.inputSchema).not.toBe(registration.inputSchema);
    expect(published.outputSchema).not.toBe(registration.outputSchema);
    expect(Object.isFrozen(published.inputSchema)).toBe(true);
    expect(Object.isFrozen(published.outputSchema)).toBe(true);
    expect(() => {
      (registration.inputSchema.properties.value as { type: string }).type = 'string';
      (registration.outputSchema.properties.doubled as { type: string }).type = 'string';
    }).not.toThrow();

    expect(published.inputSchema).toMatchObject({
      properties: { value: { type: 'integer' } },
    });
    const publishedOutputBranches = (published.outputSchema as {
      readonly oneOf: readonly AnySchema[];
    }).oneOf;
    expect(publishedOutputBranches[0]).toMatchObject({
      properties: { doubled: { type: 'integer' } },
    });
  });
});
