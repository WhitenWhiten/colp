import { describe, expect, it, vi } from 'vitest';

import {
  computeOperationsDigest,
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import {
  assessCanonicalOperations,
  assessLeafTypeRisk,
  assessToolCallRisk,
  assertOneShotToolAllowed,
  expandOperations,
} from '../../src/mcp/risk-aggregation.js';
import {
  resolveMcpWriteInputBudget,
  snapshotMcpData,
} from '../../src/mcp/safe-data.js';
import {
  readApiKeyApplicationResultKeyId,
  redactApiKeyToolResult,
  redactCommitStructuredContent,
  structuredContentContainsSecret,
  type McpFlatApiKeyApplicationResult,
} from '../../src/mcp/secret-redaction.js';
import { createMcpToolInputValidator } from '../../src/mcp/tool-input.js';
import { createMcpWriteToolGateway } from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const uriPolicy = Object.freeze({ allow: () => true });

function changePlanOptions() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  return {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => ({
      collections: 0,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    })) },
    revisions: {
      resolveBaseRevisions: vi.fn(async (
        operation: Parameters<typeof resolveFixtureBaseRevisions>[0],
      ) => resolveFixtureBaseRevisions(operation)),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    },
    scopes: { hasScopes: vi.fn(async () => true) },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(
      planStore,
      approvalStore,
      { execute: vi.fn(async () => []) },
    ),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy,
  };
}

const context = Object.freeze({
  binding: authenticatedBinding({ principalId: 'subject-t01', clientId: 'client-t01' }),
  scope: Object.freeze(['collections:write']),
  budget: Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxBytes: 1_048_576,
    maxOperations: 1_000,
  }),
  abortSignal: new AbortController().signal,
  authorization: Object.freeze({ scopes: Object.freeze(['collections:write']) }),
});

function lowRiskDefinition() {
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
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    toCanonicalOperations: () => [{ type: 'custom.write', risk: 'low' as const }],
    invoke: () => ({ ok: true }),
  };
}

describe('T-01 MCP quality-gate branch coverage', () => {
  it('covers fail-closed risk aggregation inputs and compatibility control tools', () => {
    expect(expandOperations(undefined)).toEqual([]);
    expect(() => expandOperations(undefined, '$', -1)).toThrow(/budget/iu);
    expect(() => expandOperations({}, '$', 2, { maxDepth: 1 })).toThrow(/budget/iu);
    expect(() => expandOperations({ items: [{}] }, '$', 0, { maxNodes: 1 })).toThrow(/budget/iu);
    expect(() => assessLeafTypeRisk('')).toThrow(/non-empty/iu);
    expect(assessLeafTypeRisk('access.visibility', { visibility: 'public' })).toBe('high');
    expect(assessLeafTypeRisk('access.visibility', { input: { visibility: 'private' } })).toBe('high');
    expect(assessLeafTypeRisk('vendor.delete_one')).toBe('high');
    expect(() => assessCanonicalOperations([null])).toThrow(/canonical operation/iu);
    expect(() => assessToolCallRisk('')).toThrow(/non-empty/iu);
    expect(assertOneShotToolAllowed('changes.commit')).toMatchObject({
      level: 'low',
      affectedObjects: 0,
      requiresPlan: false,
    });
    expect(() => assessToolCallRisk('custom.write', {}, { maxNodes: 0 })).toThrow(/budget/iu);

    const symbol = Symbol('ignored');
    const accessor = Object.defineProperty({ visibility: 'private' }, 'ignored', {
      enumerable: true,
      get: () => 'public',
    }) as Record<PropertyKey, unknown>;
    accessor[symbol] = 'public';
    expect(assessLeafTypeRisk('access.visibility', accessor)).toBe('high');
  });

  it('covers JSON snapshot budget and own-data rejection branches', () => {
    expect(resolveMcpWriteInputBudget({ maxDepth: undefined } as never)).toMatchObject({ maxDepth: 32 });
    expect(() => resolveMcpWriteInputBudget({ maxNodes: 0 })).toThrow(/safe integer/iu);
    expect(() => snapshotMcpData([1, 2], { maxNodes: 2 })).toThrow(/node budget/iu);
    expect(() => snapshotMcpData({ oversizedKey: true }, { maxBytes: 4 })).toThrow(/byte budget/iu);
    expect(snapshotMcpData({ nothing: null })).toEqual({ nothing: null });

    const validate = createMcpToolInputValidator({
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'integer' } },
      required: ['value'],
    });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    expect(() => validate(accessor)).toThrow(/inputSchema/iu);
    expect(() => createMcpToolInputValidator(
      { type: 'object' },
      { maxNodes: 1 },
    )({ a: 1 }))
      .toThrow();
  });

  it('covers redaction failures and the explicitly typed internal flat adapter', () => {
    const raw = { key: { id: 'key-t01' }, secret: 'secret-t01' } as never;
    expect(() => redactApiKeyToolResult(raw, null as never)).toThrow(/options/iu);
    expect(() => redactApiKeyToolResult(raw, {} as never)).toThrow(/revealUri/iu);
    expect(() => redactApiKeyToolResult(raw, {
      revealUri: 'https://host.example/keys/key-t01/reveal',
    } as never)).toThrow(/uriPolicy/iu);
    expect(() => readApiKeyApplicationResultKeyId({
      key: { id: 'key-t01' },
      secret: 42,
    } as never)).toThrow(/string secret/iu);
    expect(() => readApiKeyApplicationResultKeyId({
      key: { id: 'key-t01', privateKeyMaterial: 'forbidden' },
      secret: 'secret-t01',
    } as never)).toThrow(/secret fields/iu);
    const internalFlatResult = {
      keyId: 'key-flat',
      secret: 'removed',
    } satisfies McpFlatApiKeyApplicationResult;
    expect(readApiKeyApplicationResultKeyId(internalFlatResult)).toBe('key-flat');

    expect(() => redactCommitStructuredContent(() => undefined)).toThrow(/JSON data/iu);
    expect(() => redactCommitStructuredContent({}, null as never)).toThrow(/options/iu);
    expect(redactCommitStructuredContent({}, {})).toEqual({});
    const revealAccessor = Object.defineProperty({}, 'revealUriForKey', {
      enumerable: true,
      get: () => () => 'https://host.example/reveal',
    });
    expect(() => redactCommitStructuredContent({}, revealAccessor)).toThrow(/own-data function/iu);
    expect(() => redactCommitStructuredContent({}, { revealUriForKey: 1 as never })).toThrow(/function/iu);
    expect(() => redactCommitStructuredContent({}, { revealUriForKey: () => 'https://host.example/reveal' }))
      .toThrow(/uriPolicy/iu);
    expect(() => redactCommitStructuredContent(
      internalFlatResult,
      { revealUriForKey: () => { throw new Error('host failure'); }, uriPolicy },
    )).toThrow(/failed to produce/iu);

    const redacted = redactCommitStructuredContent(
      internalFlatResult,
      { revealUriForKey: (keyId) => `https://host.example/keys/${keyId}/reveal`, uriPolicy },
    );
    expect(redacted).toEqual({
      keyId: 'key-flat',
      secretAvailable: true,
      revealUri: 'https://host.example/keys/key-flat/reveal',
    });
  });

  it('covers malformed and cyclic redaction data without invoking accessors', () => {
    const badMetadata = Object.create(Date.prototype) as { id: string };
    badMetadata.id = 'key-t01';
    expect(() => redactApiKeyToolResult(
      { key: badMetadata, secret: 'secret' } as never,
      { revealUri: 'https://host.example/reveal', uriPolicy },
    )).toThrow(/ordinary data prototype/iu);

    const symbol = Symbol('secret');
    const symbolMetadata = { id: 'key-t01', [symbol]: 'hidden' };
    expect(() => redactApiKeyToolResult(
      { key: symbolMetadata, secret: 'secret' } as never,
      { revealUri: 'https://host.example/reveal', uriPolicy },
    )).toThrow(/symbol keys/iu);

    const hiddenMetadata = { id: 'key-t01' };
    Object.defineProperty(hiddenMetadata, 'hidden', { value: true, enumerable: false });
    expect(() => redactApiKeyToolResult(
      { key: hiddenMetadata, secret: 'secret' } as never,
      { revealUri: 'https://host.example/reveal', uriPolicy },
    )).toThrow(/enumerable data/iu);

    expect(() => redactApiKeyToolResult(
      { key: { id: 'key-t01' }, secret: 'secret', extra: true } as never,
      { revealUri: 'https://host.example/reveal', uriPolicy },
    )).toThrow(/only key and secret/iu);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(structuredContentContainsSecret(cyclic)).toBe(false);
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => ({ secret: 'x' }) });
    expect(structuredContentContainsSecret(accessor)).toBe(false);
    expect(structuredContentContainsSecret({ [Symbol('ignored')]: { secret: 'x' } })).toBe(false);
  });

  it('covers fail-closed gateway configuration and call boundaries', async () => {
    expect(() => createMcpWriteToolGateway(null as never)).toThrow(/options object/iu);
    expect(() => createMcpWriteToolGateway({ changePlan: null } as never)).toThrow(/changePlan/iu);
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      apiKeys: new Proxy({}, {}),
    } as never)).toThrow(/Proxy/iu);
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      apiKeys: { createKey: () => ({}), rotateKey: () => ({}) },
    } as never)).toThrow(/revealUriForKey/iu);
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      apiKeys: { createKey: () => ({}) },
      revealUriForKey: () => 'https://host.example/reveal',
    } as never)).toThrow(/rotateKey/iu);
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'bad name': lowRiskDefinition() },
    } as never)).toThrow(/invalid low-risk tool name/iu);

    const symbolTools = { [Symbol('bad')]: lowRiskDefinition() };
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: symbolTools,
    } as never)).toThrow(/invalid low-risk tool name/iu);
    const accessorTools = Object.defineProperty({}, 'custom.write', { enumerable: true, get: lowRiskDefinition });
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: accessorTools,
    } as never)).toThrow(/own-data definition/iu);
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': new Proxy(lowRiskDefinition(), {}) },
    } as never)).toThrow(/Proxy/iu);

    const cyclicInputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false };
    cyclicInputSchema.self = cyclicInputSchema;
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': { ...lowRiskDefinition(), inputSchema: cyclicInputSchema } },
    } as never)).toThrow(/JSON data/iu);
    const cyclicOutputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false };
    cyclicOutputSchema.self = cyclicOutputSchema;
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': { ...lowRiskDefinition(), outputSchema: cyclicOutputSchema } },
    } as never)).toThrow(/JSON data/iu);

    const gateway = createMcpWriteToolGateway({
      changePlan: { ...changePlanOptions(), planTtlMilliseconds: 60_000 },
      lowRiskTools: { 'custom.write': lowRiskDefinition() },
    } as never);
    expect(gateway.assessRisk('custom.write')).toMatchObject({ level: 'low' });
    await expect(gateway.callTool('bad name', {}, context)).rejects.toMatchObject({ code: 'unknown_tool' });
    await expect(gateway.callTool('custom.write', { value: 1 }, {
      binding: { subjectId: '', clientId: 'client', sessionId: 'session' },
      authorization: {},
    } as never)).rejects.toMatchObject({ code: 'binding_required' });
  });

  it('covers change-plan request and service configuration rejection boundaries', async () => {
    expect(() => createChangePlanService(null as never)).toThrow(/options object/iu);
    const { approvalBaseUri: _approvalBaseUri, ...withoutApprovalBase } = changePlanOptions();
    expect(() => createChangePlanService(withoutApprovalBase as never)).toThrow(/approvalBaseUri/iu);
    expect(() => createChangePlanService({
      ...changePlanOptions(),
      revealUriForKey: 1,
    } as never)).toThrow(/revealUriForKey/iu);
    expect(() => createChangePlanService({
      ...changePlanOptions(),
      inputBudget: new Proxy({}, {}),
    } as never)).toThrow(/inputBudget/iu);

    const accessorClock = Object.defineProperty(changePlanOptions(), 'clock', {
      enumerable: true,
      get: () => ({ now: () => new Date() }),
    });
    expect(() => createChangePlanService(accessorClock as never)).toThrow(/own data property/iu);
    expect(() => createChangePlanService({
      ...changePlanOptions(),
      planTtlMilliseconds: Number.NaN,
    } as never)).toThrow(/finite number/iu);

    const service = createChangePlanService(changePlanOptions());
    await expect(service.plan({}, null as never)).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
    await expect(service.plan({}, {
      subjectId: 'subject',
      clientId: '',
      sessionId: 'session',
    } as never)).rejects.toMatchObject({ code: 'plan_binding_mismatch' });
    await expect(service.plan(null, context.binding)).rejects.toMatchObject({ code: 'invalid_plan_request' });
    await expect(service.plan({}, context.binding)).rejects.toMatchObject({ code: 'invalid_plan_request' });
    await expect(service.plan({ operations: [null] }, context.binding))
      .rejects.toMatchObject({ code: 'invalid_plan_request' });
    await expect(service.plan({ operations: [{}] }, context.binding))
      .rejects.toMatchObject({ code: 'invalid_plan_request' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(service.plan(cyclic, context.binding)).rejects.toMatchObject({ code: 'invalid_plan_request' });
    await expect(service.commit('', context.binding, 'idem-t01'))
      .rejects.toMatchObject({ code: 'plan_not_found' });
    await expect(service.commit('plan-t01', context.binding, ''))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(service.cancel('', context.binding)).rejects.toMatchObject({ code: 'plan_not_found' });
    expect(() => computeOperationsDigest(undefined as never)).toThrow(/canonicalizable/iu);

    const noIdService = createChangePlanService({
      ...changePlanOptions(),
      ids: { nextPlanId: () => '' },
    });
    await expect(noIdService.plan({
      operations: [{
        type: 'delete_collection',
        collectionId: 'collection-t01',
        baseRevision: 'revision-t01',
      }],
      reason: 'quality gate',
      dryRun: true,
    }, context.binding)).rejects.toMatchObject({ code: 'invalid_plan_request' });
  });
});
