/**
 * COLP-MCP-13 test fixture: builds a Modern `2026-07-28` Write adapter over
 * the COLP-MCP-06 Write Gateway with in-memory plan/approval stores, a
 * store-backed plan-status resolver and per-request Modern contexts. Shared
 * by the write-adapters contract and write-adapter hardening suites.
 */
import { vi } from 'vitest';

import type { McpChangePlanExecutorPort, McpStoredPlan } from '../../src/mcp/change-plan.js';
import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import type { McpLowRiskToolDefinition } from '../../src/mcp/write-tools.js';
import type { McpAuthenticatedAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import {
  createAnonymousPublicBinding,
} from '../../src/mcp/shared/authorization.js';
import type { McpWriteInputBudget } from '../../src/mcp/safe-data.js';
import {
  createMcp20260728RequestContext,
  requireMcp20260728RequestContext,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  createMcp20260728WriteToolAdapter,
  type Mcp20260728PlanResolution,
  type Mcp20260728WritePlanStatusPort,
  type Mcp20260728WriteToolAdapter,
} from '../../src/mcp/2026-07-28/write.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export const serverInfo = Object.freeze({ name: 'colp-write-test-server', version: '0.0.0' });
export const TEST_REQUEST_STATE_KEY = 'colp-mcp-13-test-request-state-key-0123456789abcdef';

export const DEFAULT_BUDGET = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1_048_576,
  maxOperations: 1_000,
});

export function changePlanOptions(options: Readonly<{
  executor?: McpChangePlanExecutorPort | undefined;
  planStore?: ReturnType<typeof createInMemoryPlanStore>;
  approvalStore?: ReturnType<typeof createInMemoryApprovalStore>;
  /** Injectable clock shared with the plan-status resolver for deterministic expiry tests. */
  clock?: { now: () => Date };
}> = {}) {
  const planStore = options.planStore ?? createInMemoryPlanStore();
  const approvalStore = options.approvalStore ?? createInMemoryApprovalStore();
  const executor = options.executor ?? { execute: vi.fn(async () => []) };
  return {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => ({
      collections: 1,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    })) },
    revisions: {
      resolveBaseRevisions: vi.fn(async (operation: unknown) =>
        resolveFixtureBaseRevisions(operation as never)),
      currentRevisions: vi.fn(async (_transaction: object, base: Readonly<Record<string, string>>) =>
        ({ ...base })),
    },
    scopes: { hasScopes: vi.fn(async () => true) },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
}

export function planRequest(operation: unknown = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-1',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
})) {
  return {
    operations: [operation],
    reason: 'User asked to publish the collection',
    dryRun: true as const,
  };
}

export function commitInput(planId: string, idempotencyKey = 'idem-1') {
  return { planId, idempotencyKey };
}

export function projectPlan(plan: McpStoredPlan): Readonly<Record<string, unknown>> {
  return Object.freeze({
    planId: plan.planId,
    expiresAt: plan.expiresAt,
    risk: plan.risk,
    requiresApproval: plan.requiresApproval,
    summary: plan.summary,
    impact: plan.impact,
    requiredScopes: [...plan.requiredScopes],
    baseRevisions: { ...plan.baseRevisions },
    ...(plan.approvalMethod !== undefined ? { approvalMethod: plan.approvalMethod } : {}),
    ...(plan.approvalUri !== undefined ? { approvalUri: plan.approvalUri } : {}),
  });
}

export function planStatusResolver(
  planStore: ReturnType<typeof createInMemoryPlanStore>,
  nowMs: () => number = () => Date.now(),
): Mcp20260728WritePlanStatusPort {
  return {
    resolvePlan: async (
      planId: string,
      _binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<Mcp20260728PlanResolution> => {
      const plan = await planStore.get(planId);
      if (plan === undefined) return Object.freeze({ status: 'unknown' });
      const expired =
        Date.parse(plan.expiresAt) <= nowMs()
        && plan.status !== 'consumed'
        && plan.status !== 'cancelled';
      const status = expired ? 'expired' : plan.status;
      return Object.freeze({ status, plan: projectPlan(plan) });
    },
  };
}

export function header(name: string, value: string): Mcp20260728HeaderField {
  return { name, value };
}

export function meta(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

export function createContext(
  binding: McpAuthenticatedAuthorizationBinding,
  overrides: Readonly<Record<string, unknown>> = {},
): Mcp20260728RequestContext {
  return requireMcp20260728RequestContext(createMcp20260728RequestContext({
    headers: [header('mcp-protocol-version', '2026-07-28'), header('mcp-method', 'tools/call')],
    httpMethod: 'POST',
    body: { method: 'tools/call', params: { _meta: meta() } },
    binding,
    ...overrides,
  } as Mcp20260728RequestContextInput));
}

export function anonymousContext(): Mcp20260728RequestContext {
  return createContext(createAnonymousPublicBinding({
    resourceAudience: 'urn:colp:resource:public',
    securityEpoch: 'epoch-1',
  }) as never);
}

export function lowRiskDescriptor(overrides: Readonly<Record<string, unknown>> = {}): McpLowRiskToolDefinition {
  return {
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { mode: { type: 'string' as const, enum: ['private', 'public'] } },
      required: ['mode'],
    },
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' as const },
        mode: { type: 'string' as const, enum: ['private', 'public'] },
      },
    },
    toCanonicalOperations: () => [{ type: 'custom.write', risk: 'low' as const }],
    invoke: () => ({ ok: true }),
    ...overrides,
  };
}

export interface HarnessOptions {
  readonly planStore?: ReturnType<typeof createInMemoryPlanStore>;
  readonly executor?: McpChangePlanExecutorPort;
  readonly lowRiskTools?: Readonly<Record<string, McpLowRiskToolDefinition>>;
  readonly resolvePlan?: Mcp20260728WritePlanStatusPort;
  readonly revealUriForKey?: (keyId: string) => string;
  readonly requestStateTtlSeconds?: number;
  readonly requestStateClock?: () => number;
  readonly changePlanClock?: { now: () => Date };
  readonly binding?: McpAuthenticatedAuthorizationBinding;
}

export function harness(options: HarnessOptions = {}) {
  const planStore = options.planStore ?? createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = options.executor ?? { execute: vi.fn(async () => []) };
  const adapter = createMcp20260728WriteToolAdapter({
    changePlan: changePlanOptions({
      executor,
      planStore,
      approvalStore,
      ...(options.changePlanClock !== undefined ? { clock: options.changePlanClock } : {}),
    }),
    ...(options.revealUriForKey !== undefined ? { revealUriForKey: options.revealUriForKey } : {}),
    ...(options.lowRiskTools !== undefined ? { lowRiskTools: options.lowRiskTools } : {}),
    serverInfo,
    requestStateKey: TEST_REQUEST_STATE_KEY,
    resolvePlan: options.resolvePlan ?? planStatusResolver(planStore),
    ...(options.requestStateTtlSeconds !== undefined
      ? { requestStateTtlSeconds: options.requestStateTtlSeconds }
      : {}),
    ...(options.requestStateClock !== undefined ? { requestStateClock: options.requestStateClock } : {}),
  });
  const binding = options.binding ?? authenticatedBinding({ principalId: 'write-principal' });
  return {
    adapter,
    planStore,
    approvalStore,
    executor,
    binding,
    context: createContext(binding),
    budget: DEFAULT_BUDGET as McpWriteInputBudget,
  };
}

export async function firstPlanResult(
  adapter: Mcp20260728WriteToolAdapter,
  context: Mcp20260728RequestContext,
) {
  return adapter.callTool(context, { name: 'changes.plan', arguments: planRequest() });
}



