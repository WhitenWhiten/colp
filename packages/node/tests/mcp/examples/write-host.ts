/**
 * COLP-MCP-13: minimal MCP Write host example (type-checked).
 *
 * Mirrors the fenced example in `docs/progress/MCP_WRITE.md`. The Modern
 * `2026-07-28` Write adapter (`createMcp20260728WriteToolAdapter`) is the
 * public `/mcp` surface; the host wires the protocol-neutral change-plan
 * options (stores, impact/revision/scope/authorization/rate-limit ports and
 * a commit coordinator) that the adapter hands to the internal Write Gateway
 * (COLP-MCP-06) — the gateway and change-plan core stay internal to the
 * package. Hosts owning durable storage provide their own
 * `McpChangePlanStorePort` / `McpApprovalStorePort`; this example uses the
 * bounded in-memory helpers (imported at source level for the type-checked
 * mirror; the package exports map deliberately keeps the write core off the
 * public subpaths).
 *
 * The host transport maps verified stdio evidence to an authenticated
 * token-free binding, builds one trusted per-request context and forwards the
 * tool call with optional MRTR retry fields (`requestState`,
 * `inputResponses`). The adapter returns a Modern result (`complete` or MRTR
 * `input_required`); a host transport serializes that result on the wire.
 */
import {
  createMcp20260728RequestContext,
  createMcp20260728WriteToolAdapter,
  mapStdioEvidenceToAuthenticatedBinding,
  type Mcp20260728PlanResolution,
  type Mcp20260728Result,
  type McpAuthenticatedAuthorizationBinding,
} from '../../../src/mcp/index.js';
import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  type McpStoredPlan,
} from '../../../src/mcp/change-plan.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from '../commit-coordinator-fixture.js';

const planStore = createInMemoryPlanStore();
const approvalStore = createInMemoryApprovalStore();

/** Host-owned executor: applies approved operations inside the commit. */
const executor = { execute: async () => [] };

/**
 * Host-owned plan-status resolver backing the server-minted `requestState`
 * retry channel: resolves the current plan status and a protocol-neutral plan
 * projection (same shape as `changes.plan` structuredContent).
 */
const resolvePlan = async (
  planId: string,
  _binding: McpAuthenticatedAuthorizationBinding,
): Promise<Mcp20260728PlanResolution> => {
  const plan = await planStore.get(planId);
  if (plan === undefined) return { status: 'unknown' };
  const projected = projectPlan(plan);
  return { status: plan.status, plan: projected };
};

function projectPlan(plan: McpStoredPlan): Readonly<Record<string, unknown>> {
  return {
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
  };
}

/** One frozen adapter instance serves concurrent per-request contexts. */
const writeToolAdapter = createMcp20260728WriteToolAdapter({
  changePlan: {
    planStore,
    approvalStore,
    impact: {
      assessImpact: async () => ({
        collections: 1,
        nodes: 0,
        annotations: 0,
        attachments: 0,
        relations: 0,
        privateFieldsExcluded: [],
      }),
    },
    revisions: {
      resolveBaseRevisions: async (operation) => resolveFixtureBaseRevisions(operation),
      currentRevisions: async (_transaction, base) => ({ ...base }),
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: async () => true },
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
  },
  serverInfo: Object.freeze({ name: 'collection-write-host', version: '0.0.0' }),
  resolvePlan: { resolvePlan },
  // Host-owned HMAC key (>= 32 bytes) protecting server-minted requestState.
  requestStateKey: 'host-request-state-key-0123456789abcdef0123456789abcdef',
});

/**
 * Host transport entry for a Write Tools mount: maps verified local stdio
 * evidence to a token-free authenticated binding, builds one trusted
 * per-request context and forwards a `tools/call` (with optional MRTR retry
 * fields) to the shared Modern Write adapter.
 */
export async function handleWriteToolCall(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
  input: Readonly<{
    name: string;
    arguments?: Readonly<Record<string, unknown>>;
    requestState?: string;
    inputResponses?: Readonly<Record<string, unknown>>;
  }>,
): Promise<Mcp20260728Result> {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: mapStdioEvidenceToAuthenticatedBinding({
      credentialKind: 'stdio',
      principalId: 'local-principal',
      clientId: 'stdio-host-1',
      credentialBindingId: 'local-secret-binding-1',
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return writeToolAdapter.callTool(context, input);
}

export { writeToolAdapter, planStore, approvalStore };




