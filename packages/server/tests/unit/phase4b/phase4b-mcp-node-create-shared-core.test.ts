import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { ChangePlanImpact, ScopeName } from '@know-n/colp/types';
import {
  Phase4bMcpChangePlanPlannerError,
  createPhase4bMcpChangePlanPlanner,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpNodeCreateOperation,
  type Phase4bMcpPlannedChange,
} from '../../../src/modules/mcp/change-plan-planner.js';
import { executeMcpNodeCreate } from '../../../src/modules/mcp/node-create-execution.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
} from '../../../src/modules/mcp/low-risk-node-create.js';
import {
  canonicalMcpNodeCreatePayload,
  parseMcpNodeCreatePayload,
} from '../../../src/modules/mcp/node-create-payload.js';
import type { ProductCollectionCanonicalPorts } from '../../../src/modules/collections/index.js';
import {
  CONTEXT,
  IDEMPOTENCY_KEY,
  createCapturingService,
  createFakePorts,
  createUowProbe,
  createdResult,
  type CapturedCreateKindFields,
} from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const APPROVAL_ORIGIN = 'https://approve.example';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const NOW = '2026-08-05T12:00:00.000Z';

const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: [],
});

function plannerOptions(): Phase4bMcpChangePlanPlannerOptions {
  return Object.freeze({
    planStore: Object.freeze({
      save() {
        return undefined;
      },
      get() {
        return undefined;
      },
    }),
    authoritativeState: Object.freeze({
      resolveCreateBaseRevisions: async () => Object.freeze({
        parentChildrenRevision: 'children-r1',
        collectionContentRevision: 'content-r1',
        collectionVisibility: 'private' as const,
      }),
      resolveVisibilityFacts: async () => Object.freeze({
        resourceRevision: 'resource-r1',
        policyRevision: 'policy-r1',
      }),
    }),
    authorizationPolicy: Object.freeze({
      requiredScopesForOperation: async () => Object.freeze([] as readonly ScopeName[]),
    }),
    impact: Object.freeze({ assessImpact: async () => IMPACT }),
    approvalBaseUri: `${APPROVAL_ORIGIN}/approvals`,
    approvalUriPolicy: Object.freeze({
      allow: (input: { purpose: 'approval'; origin: string }) =>
        input.purpose === 'approval' && input.origin === APPROVAL_ORIGIN,
    }),
    clock: Object.freeze({ now: () => new Date(NOW) }),
    ids: Object.freeze({
      nextPlanId: () => 'plan-w03-shared-core',
      nextOperationId: () => 'op-w03-shared-core',
    }),
    serverUuid: SERVER_UUID,
  });
}

function createCatalogInput(node: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    tool: 'nodes.create' as const,
    collectionId: 'collection-1',
    parentId: 'root-1',
    afterId: null,
    beforeId: null,
    node: Object.freeze(node),
    reason: 'create a node',
    dryRun: true as const,
  });
}

function createNodeRequest(node: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    input: Object.freeze({
      tool: 'nodes.create' as const,
      collectionId: 'collection-1',
      parentId: 'root-1',
      afterId: null,
      beforeId: null,
      node: Object.freeze(node),
      reason: 'create a node',
      confirmApply: true as const,
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedBaseRevisions: Object.freeze({}),
  });
}

function capturingPorts() {
  const probe = createUowProbe();
  const base = createFakePorts(createdResult(), probe);
  const captured: CapturedCreateKindFields[] = [];
  const ports: ProductCollectionCanonicalPorts = Object.freeze({
    ...base,
    canonical: Object.freeze({
      ...base.canonical,
      execute: async (input: Parameters<typeof base.canonical.execute>[0]) => {
        captured.push(input.mutation.fields.kindFields);
        return base.canonical.execute(input);
      },
    }),
  });
  return { probe, ports, captured };
}

/**
 * Mirrors the parse-and-execute step of the production Plan commit body
 * (`change-plan-service.executeNodeCreate`): it feeds the stored canonical node
 * back through the shared parser and runs the same transaction-bound
 * `executeMcpNodeCreate` core on the caller's product ports. This helper
 * isolates the shared parser/core contract; the production `service.commit`
 * entry itself is exercised in `phase4b-mcp-change-plan-service.test.ts`
 * ("...executes through the shared transaction-bound core").
 */
async function executePlanStoredOperation(
  plan: Phase4bMcpPlannedChange,
  ports: ProductCollectionCanonicalPorts,
) {
  const operation = plan.operations[0] as Phase4bMcpNodeCreateOperation;
  const payload = operation.payload;
  return executeMcpNodeCreate(ports, {
    collectionId: operation.collectionId,
    parentId: payload.parentId,
    afterId: payload.afterId ?? null,
    beforeId: payload.beforeId ?? null,
    node: parseMcpNodeCreatePayload(payload.node),
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedBaseRevisions: plan.baseRevisions,
  }, {
    binding: BINDING,
    accountSubjectId: BINDING.principalId,
    scope: plan.requiredScopes,
  });
}

const SHARED_CASES = [
  { kind: 'folder', title: 'Shared folder', visibility: 'inherit' },
  { kind: 'bookmark', title: 'Shared bookmark', url: 'https://example.com/shared', visibility: 'protected' },
  {
    kind: 'bookmark',
    title: 'Explicit bookmark',
    url: 'https://example.com/explicit',
    description: 'kept description',
    tags: ['one', 'two'],
    visibility: 'private',
  },
] as const;

test('plan-path and direct nodes.create resolve identical fields through the shared parser and core', async () => {
  for (const rawNode of SHARED_CASES) {
    const planner = createPhase4bMcpChangePlanPlanner(plannerOptions());
    const plan = await planner.plan(createCatalogInput(rawNode), BINDING);
    const operation = plan.operations[0] as Phase4bMcpNodeCreateOperation;

    // The planner admitted the payload with the shared parser and stored its
    // canonical projection, not a transport request.
    assert.deepEqual(
      operation.payload.node,
      canonicalMcpNodeCreatePayload(parseMcpNodeCreatePayload(rawNode)),
      rawNode.title,
    );

    const planRun = capturingPorts();
    const planResult = await executePlanStoredOperation(plan, planRun.ports);
    assert.equal(planResult.kind, 'created', rawNode.title);

    const directRun = createCapturingService(createdResult());
    const directOutput = await directRun.service.execute(createNodeRequest(rawNode), CONTEXT);
    assert.equal(directOutput.resultType, 'complete', rawNode.title);

    // Same resolved title/description/tags/visibility/url and folder-vs-bookmark
    // shape on both paths, because both drive the stored payload through the
    // one shared parser and transaction-bound core.
    assert.deepEqual(directRun.capture.kindFields, planRun.captured[0], rawNode.title);
    const resolved = planRun.captured[0];
    assert.ok(resolved, rawNode.title);
    assert.equal(resolved.kind, rawNode.kind, rawNode.title);
    assert.equal(resolved.title, rawNode.title, rawNode.title);
    assert.equal(resolved.description, 'description' in rawNode ? rawNode.description : null);
    assert.deepEqual(resolved.tags, 'tags' in rawNode ? rawNode.tags : []);
    assert.equal(resolved.visibility, rawNode.visibility);
    assert.equal(resolved.url, rawNode.kind === 'bookmark' ? rawNode.url : null);

    // Both paths executed the shared transaction-bound core: receipt claim plus
    // the canonical mutation ran on the caller's product ports.
    assert.ok(planRun.probe.claimCalls >= 1, rawNode.title);
    assert.ok(directRun.probe.claimCalls >= 1, rawNode.title);
    assert.equal(planRun.captured.length, 1, rawNode.title);
    assert.equal(directRun.probe.callbackInvoked, true, rawNode.title);
  }
});

test('approved Plan and direct nodes.create admit through the same payload parser', async () => {
  const malformed = [
    { node: { kind: 'folder', title: 'F', visibility: 'inherit', extra: true }, code: 'open_payload_rejected' },
    { node: { kind: 'bookmark', title: 'B', url: 'ftp://example.com', visibility: 'private' }, code: 'invalid_catalog_input' },
    { node: { kind: 'folder', title: 'F', url: 'https://example.com', visibility: 'inherit' }, code: 'invalid_catalog_input' },
  ] as const;

  for (const { node, code } of malformed) {
    const planner = createPhase4bMcpChangePlanPlanner(plannerOptions());
    await assert.rejects(
      planner.plan(createCatalogInput(node), BINDING),
      (error: unknown) => error instanceof Phase4bMcpChangePlanPlannerError && error.code === code,
      `plan: ${JSON.stringify(node)}`,
    );
    const direct = createCapturingService(createdResult());
    await assert.rejects(
      direct.service.execute(createNodeRequest(node), CONTEXT),
      (error: unknown) => error instanceof Phase4bMcpLowRiskNodeCreateError && error.code === code,
      `direct: ${JSON.stringify(node)}`,
    );
  }
});
