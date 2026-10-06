import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * U-2 MCP coverage gaps — high-risk Plan/Commit, mount exposure, read-client,
 * Resource Server, risk budget, and secret non-reflection branches identified
 * from `coverage/mcp/` at commit 06dac2b (lines 94.80 / branches 89.27).
 *
 * Each case asserts a stable public observation that would change if the
 * guarding condition were inverted (not merely that coverage rose).
 */

import {
  computeOperationsDigest,
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  McpChangePlanError,
  type McpChangePlanCommitCoordinatorPort,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import {
  createCollectionsGetTool,
  createMcpReadToolGateway,
} from '../../src/mcp/collections-get.js';
import {
  createMcpReadClient,
  McpReadClientError,
  type McpReadClientRecord,
} from '../../src/mcp/read-client.js';
import {
  createMcpAnonymousReadExposure,
  createMcpReadExposure,
  McpAnonymousResourceUnavailableError,
  McpReadMountConfigurationError,
} from '../../src/mcp/read-mount.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';
import {
  createMcpStatelessReadCore,
  McpReadRequestContextError,
  McpResourceRequestError,
} from '../../src/mcp/shared/resources.js';
import { readContext } from './read-trusted-context-fixture.js';
import {
  assertOneShotCanonicalOperationsAllowed,
  assessLeafTypeRisk,
  assessToolCallRisk,
  expandOperations,
  McpHighRiskRequiresPlanError,
  McpRiskAggregationError,
} from '../../src/mcp/risk-aggregation.js';
import {
  McpSecretRedactionError,
  redactCommitStructuredContent,
  redactModelFacingStructuredContent,
  structuredContentContainsSecret,
} from '../../src/mcp/secret-redaction.js';
import {
  createMcpWriteExposure,
  McpWriteMountConfigurationError,
} from '../../src/mcp/write-mount.js';
import type { Manifest } from '../../src/types/index.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const bindingA = authenticatedBinding({
  principalId: 'user-a',
  clientId: 'client-a',
});

const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const metadataUri = `colp://${serverUuid}/collections/collection-1`;
const allowAllUriPolicy = Object.freeze({ allow: () => true });

function highRiskOp(visibility: 'public' | 'unlisted' | 'private' = 'public') {
  return Object.freeze({
    type: 'set_visibility' as const,
    collectionId: 'collection-1',
    baseRevision: 'acl_17',
    input: Object.freeze({ visibility }),
  });
}

function planRequest(operations = [highRiskOp()]) {
  return {
    operations,
    reason: 'User asked to publish the collection',
    dryRun: true as const,
  };
}

function sampleImpact(nodes = 48) {
  return {
    collections: 1,
    nodes,
    annotations: 6,
    attachments: 0,
    relations: 12,
    privateFieldsExcluded: ['sourceRefs'] as string[],
  };
}

function createPlanHarness(overrides: Record<string, unknown> = {}) {
  const planStore = (overrides.planStore as ReturnType<typeof createInMemoryPlanStore> | undefined)
    ?? createInMemoryPlanStore();
  const approvalStore = (overrides.approvalStore as ReturnType<typeof createInMemoryApprovalStore> | undefined)
    ?? createInMemoryApprovalStore();
  const authoritativeRevisions = new Map<string, string>();
  const impact = {
    assessImpact: vi.fn(async () => sampleImpact()),
  };
  const revisions = {
    resolveBaseRevisions: vi.fn(async (operation) => {
      const resolved = resolveFixtureBaseRevisions(operation);
      for (const [namespace, revision] of Object.entries(resolved)) {
        if (!authoritativeRevisions.has(namespace)) authoritativeRevisions.set(namespace, revision);
      }
      return resolved;
    }),
    currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) =>
      Object.fromEntries(
        Object.keys(base).map((namespace) => [
          namespace,
          authoritativeRevisions.get(namespace) ?? 'missing_authoritative_revision',
        ]),
      )),
  };
  const scopes = { hasScopes: vi.fn(async () => true) };
  const authorizationPolicy = {
    requiredScopesForOperation: vi.fn(async () => []),
  };
  const defaultExecutor = {
    execute: vi.fn(async () => [
      {
        opId: 'op-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r_1043',
        cursor: 'cur_1',
        warnings: [] as [],
      },
    ]),
  };
  const rateLimit = { allow: vi.fn(async () => true) };
  const executor = (overrides.executor ?? defaultExecutor) as typeof defaultExecutor;
  const baseCoordinator = createCommitCoordinatorFixture(planStore, approvalStore, executor);
  const commitCoordinator = (overrides.commitCoordinator ?? baseCoordinator) as
    McpChangePlanCommitCoordinatorPort;
  let now = new Date('2026-07-16T07:00:00.000Z');
  const {
    executor: _ignore,
    commitCoordinator: _c,
    planStore: _ps,
    approvalStore: _as,
    ...serviceOverrides
  } = overrides;
  const service = createChangePlanService({
    planStore,
    approvalStore,
    impact,
    revisions,
    scopes,
    authorizationPolicy,
    commitCoordinator,
    rateLimit,
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: allowAllUriPolicy,
    ids: { nextPlanId: () => 'plan_u2_gaps' },
    clock: { now: () => now },
    ...(serviceOverrides as object),
  } as Parameters<typeof createChangePlanService>[0]);
  return {
    service,
    planStore,
    approvalStore,
    executor,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

function changePlanPorts() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = { execute: vi.fn(async () => [] as const) };
  return {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => sampleImpact(0)) },
    revisions: {
      resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
      currentRevisions: vi.fn(async (_t, base: Readonly<Record<string, string>>) => ({ ...base })),
    },
    scopes: { hasScopes: vi.fn(async () => true) },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: allowAllUriPolicy,
  };
}

function resourceService(overrides: Record<string, unknown> = {}) {
  return {
    listResources: vi.fn(async () => ({ resources: [] })),
    readResource: vi.fn(async () => ({
      contents: [{
        mimeType: 'text/plain',
        text: 'ok',
        provenance: { origin: 'internal' },
      }],
    })),
    authorizeSubscription: vi.fn(async () => ({
      authorized: true,
      authorization: Object.freeze({ principal: 'alice' }),
    })),
    reauthorizeSubscription: vi.fn(async () => true),
    authorizeListChangedNotification: vi.fn(async () => true),
    ...overrides,
  };
}

function serialized(value: unknown): string {
  try {
    return `${String(value)}\n${JSON.stringify(value)}`;
  } catch {
    return String(value);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('U-2 gaps: change-plan binding / digest / cancel / tx recovery [evidence:mcp.plan-commit]', () => {
  it('Given empty planId, When recording approval, Then plan_not_found and executor never runs', async () => {
    const { service, executor } = createPlanHarness();
    await expect(service.recordOutOfBandApproval('', bindingA)).rejects.toMatchObject({
      name: 'McpChangePlanError',
      code: 'plan_not_found',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given an expired pending plan, When cancelling, Then plan_expired and executor stays idle', async () => {
    const ctx = createPlanHarness({ planTtlMilliseconds: 1_000 });
    const plan = await ctx.service.plan(planRequest(), bindingA);
    ctx.advance(5_000);
    await expect(ctx.service.cancel(plan.planId, bindingA)).rejects.toMatchObject({
      code: 'plan_expired',
    });
    expect(ctx.executor.execute).not.toHaveBeenCalled();
  });

  it('Given a cancelled plan, When cancelling again, Then durable cancelled result (idempotent)', async () => {
    const { service, executor } = createPlanHarness();
    const plan = await service.plan(planRequest(), bindingA);
    const first = await service.cancel(plan.planId, bindingA);
    const second = await service.cancel(plan.planId, bindingA);
    expect(first).toEqual({ planId: plan.planId, status: 'cancelled' });
    expect(second).toEqual(first);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given approval recorded without plan status transition, When committing, Then plan_not_approved', async () => {
    const { service, planStore, approvalStore, executor } = createPlanHarness();
    const plan = await service.plan(planRequest(), bindingA);
    const stored = (await planStore.get(plan.planId)) as McpStoredPlan;
    expect(stored.status).toBe('pending');
    await approvalStore.markApproved({
      planId: stored.planId,
      binding: bindingA,
      operationsDigest: stored.operationsDigest,
    });
    await expect(service.commit(plan.planId, bindingA, 'idem-not-approved')).rejects.toMatchObject({
      code: 'plan_not_approved',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given approval digest differs from locked plan, When committing, Then digest_mismatch', async () => {
    const { service, planStore, approvalStore, executor } = createPlanHarness();
    const plan = await service.plan(planRequest(), bindingA);
    const stored = (await planStore.get(plan.planId)) as McpStoredPlan;
    await approvalStore.markApproved({
      planId: stored.planId,
      binding: bindingA,
      operationsDigest: 'sha-256:not-the-plan-digest',
    });
    await planStore.update(Object.freeze({ ...stored, status: 'approved' as const }));
    await expect(service.commit(plan.planId, bindingA, 'idem-digest')).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given approval binding differs from commit principal, When committing, Then plan_binding_mismatch', async () => {
    const { service, planStore, approvalStore, executor } = createPlanHarness();
    const plan = await service.plan(planRequest(), bindingA);
    const stored = (await planStore.get(plan.planId)) as McpStoredPlan;
    await approvalStore.markApproved({
      planId: stored.planId,
      binding: authenticatedBinding({ principalId: 'other-subject' }),
      operationsDigest: stored.operationsDigest,
    });
    await planStore.update(Object.freeze({ ...stored, status: 'approved' as const }));
    await expect(service.commit(plan.planId, bindingA, 'idem-bind')).rejects.toMatchObject({
      code: 'plan_binding_mismatch',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given beginCommit returns an unknown status, When committing, Then commit_failed closed', async () => {
    const planStore = createInMemoryPlanStore();
    const approvalStore = createInMemoryApprovalStore();
    const executor = {
      execute: vi.fn(async () => {
        throw new Error('executor must not run');
      }),
    };
    const base = createCommitCoordinatorFixture(planStore, approvalStore, executor);
    const commitCoordinator: McpChangePlanCommitCoordinatorPort = Object.freeze({
      ...base,
      approvalStore: Object.freeze({
        ...base.approvalStore,
        beginCommit: vi.fn(async () => Object.freeze({ status: 'paused' as never })),
      }),
    });
    const { service } = createPlanHarness({ planStore, approvalStore, executor, commitCoordinator });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    await expect(service.commit(plan.planId, bindingA, 'idem-paused')).rejects.toMatchObject({
      code: 'commit_failed',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given stored operations drift under a frozen digest, When committing, Then digest_mismatch', async () => {
    const { service, planStore, approvalStore, executor } = createPlanHarness();
    const plan = await service.plan(planRequest([highRiskOp('public')]), bindingA);
    const stored = (await planStore.get(plan.planId)) as McpStoredPlan;
    const driftedOps = [highRiskOp('unlisted')];
    expect(computeOperationsDigest(driftedOps)).not.toBe(stored.operationsDigest);
    await approvalStore.markApproved({
      planId: stored.planId,
      binding: bindingA,
      operationsDigest: stored.operationsDigest,
    });
    await planStore.update(Object.freeze({
      ...stored,
      status: 'approved' as const,
      operations: driftedOps,
    }));
    await expect(service.commit(plan.planId, bindingA, 'idem-live-digest')).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('Given commit rollback throws after execute failure, When committing, Then rollback commit_failed', async () => {
    const planStore = createInMemoryPlanStore();
    const approvalStore = createInMemoryApprovalStore();
    const executor = {
      execute: vi.fn(async () => {
        throw new Error('executor-boom');
      }),
    };
    const base = createCommitCoordinatorFixture(planStore, approvalStore, executor);
    const commitCoordinator: McpChangePlanCommitCoordinatorPort = Object.freeze({
      ...base,
      rollback: vi.fn(async () => {
        throw new Error('rollback-boom');
      }),
    });
    const { service } = createPlanHarness({ planStore, approvalStore, executor, commitCoordinator });
    const plan = await service.plan(planRequest(), bindingA);
    await service.recordOutOfBandApproval(plan.planId, bindingA);
    const error = await service.commit(plan.planId, bindingA, 'idem-rollback').then(
      () => {
        throw new Error('expected reject');
      },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(McpChangePlanError);
    expect(error).toMatchObject({ code: 'commit_failed' });
    expect(String(error)).toMatch(/rollback failed/i);
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('Given cancel release throws, When cancelling, Then release commit_failed fail-closed', async () => {
    const planStore = createInMemoryPlanStore();
    const approvalStore = createInMemoryApprovalStore();
    const executor = { execute: vi.fn(async () => []) };
    const base = createCommitCoordinatorFixture(planStore, approvalStore, executor);
    const commitCoordinator: McpChangePlanCommitCoordinatorPort = Object.freeze({
      ...base,
      release: vi.fn(async () => {
        throw new Error('release-boom');
      }),
    });
    const { service } = createPlanHarness({ planStore, approvalStore, executor, commitCoordinator });
    const plan = await service.plan(planRequest(), bindingA);
    const error = await service.cancel(plan.planId, bindingA).then(
      () => {
        throw new Error('expected reject');
      },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(McpChangePlanError);
    expect(error).toMatchObject({ code: 'commit_failed' });
    expect(String(error)).toMatch(/release failed/i);
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe('U-2 gaps: write/read mount + collections.get exposure [evidence:schema.mcp-write-tools]', () => {
  it('Given missing writeTools, When creating write exposure, Then missing_write_tool_options', async () => {
    const manifest = await loadManifest();
    const mount = manifest.mounts[0]!;
    expect(() =>
      createMcpWriteExposure(manifest, { mountId: mount.id } as never),
    ).toThrow(McpWriteMountConfigurationError);
    try {
      createMcpWriteExposure(manifest, { mountId: mount.id } as never);
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing_write_tool_options' });
    }
  });

  it('Given accessor mountId, When creating write exposure, Then mcp_write_mount_not_found', async () => {
    const manifest = await loadManifest();
    const mount = manifest.mounts[0]!;
    const options = Object.defineProperties({}, {
      mountId: { enumerable: true, get: () => mount.id },
      writeTools: { enumerable: true, value: { changePlan: changePlanPorts() } },
    });
    expect(() => createMcpWriteExposure(manifest, options as never)).toThrow(
      McpWriteMountConfigurationError,
    );
    try {
      createMcpWriteExposure(manifest, options as never);
    } catch (error) {
      expect(error).toMatchObject({ code: 'mcp_write_mount_not_found' });
    }
  });

  it('Given gateway arity > 2, When creating read tool gateway, Then TypeError and port unused', () => {
    const getCollection = vi.fn(async () => ({ id: 'c1' }));
    const callWithUncheckedArity = createMcpReadToolGateway as (...args: unknown[]) => unknown;
    expect(() =>
      callWithUncheckedArity({ getCollection }, undefined, { extra: true }),
    ).toThrow(/at most a port and options/i);
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('Given null collections port, When creating collections.get, Then TypeError', () => {
    expect(() => createCollectionsGetTool(null as never)).toThrow(
      /Collection read application service/i,
    );
  });

  it('Given surplus gateway option keys, When creating read gateway, Then TypeError', () => {
    const getCollection = vi.fn(async () => ({ id: 'c1' }));
    expect(() =>
      createMcpReadToolGateway({ getCollection }, { snapshotLink: undefined, extra: true } as never),
    ).toThrow(/only own an optional snapshotLink/i);
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('Given accessor snapshotLink, When creating read gateway, Then TypeError', () => {
    const getCollection = vi.fn(async () => ({ id: 'c1' }));
    const options = Object.defineProperty({}, 'snapshotLink', {
      enumerable: true,
      get: () => ({
        manifest: { serverUuid },
        applicationService: { getCollectionSnapshotLinkMetadata: vi.fn() },
      }),
    });
    expect(() => createMcpReadToolGateway({ getCollection }, options as never)).toThrow(
      /own enumerable data property/i,
    );
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('Given accessor snapshotLinkService on read mount, When exposing tools, Then missing_read_application_service', async () => {
    const manifest = await loadManifest();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core', 'mcp-read'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };
    const getCollection = vi.fn(async () => ({ id: 'c1' }));
    const options = Object.defineProperties({}, {
      mountId: { enumerable: true, value: mount.id },
      applicationService: { enumerable: true, value: { getCollection } },
      snapshotLinkService: {
        enumerable: true,
        get: () => ({ getCollectionSnapshotLinkMetadata: vi.fn() }),
      },
    });
    expect(() => createMcpReadExposure(manifest, options as never)).toThrow(
      McpReadMountConfigurationError,
    );
    try {
      createMcpReadExposure(manifest, options as never);
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing_read_application_service' });
    }
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('Given anonymous readResource called with extra args, When reading, Then anonymous_resource_unavailable', async () => {
    const manifest = await loadManifest();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core', 'mcp-read'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };
    mount.auth.anonymousRead = true;
    const readPublicResource = vi.fn(async () => ({ id: 'public' }));
    const exposure = createMcpAnonymousReadExposure(manifest, {
      mountId: mount.id,
      publicAccess: { readPublicResource },
    });
    await expect(
      (exposure.readResource as (...args: unknown[]) => Promise<unknown>)(metadataUri, 'extra'),
    ).rejects.toBeInstanceOf(McpAnonymousResourceUnavailableError);
    expect(readPublicResource).not.toHaveBeenCalled();
  });
});

describe('U-2 gaps: read-client status paths [evidence:mcp.read-client-safety]', () => {
  const input = Object.freeze({ collectionId: 'collection-1' });
  const result = Object.freeze({ structuredContent: Object.freeze({ id: 'collection-1' }) });

  function harness(overrides: Record<string, unknown> = {}) {
    const gateway = { callTool: vi.fn(async () => result) };
    const presenter = { displayToolCall: vi.fn(async () => undefined) };
    const recorder = {
      recordToolCall: vi.fn(async (_record: McpReadClientRecord) => undefined),
    };
    const resultValidator = {
      validateToolResult: vi.fn((_name: string, value: unknown) => value),
    };
    const targetResolver = {
      resolveTargetCollection: vi.fn(() => 'collection-1'),
    };
    const client = createMcpReadClient({
      gateway,
      presenter,
      recorder,
      resultValidator,
      targetResolver,
      timeoutMs: 1_000,
      maxResultBytes: 4_096,
      ...overrides,
    } as never);
    return { client, gateway, presenter, recorder, resultValidator, targetResolver };
  }

  it('Given empty target collection, When calling tool, Then failed status and gateway idle', async () => {
    const { client, gateway, recorder, presenter } = harness({
      targetResolver: { resolveTargetCollection: vi.fn(() => '') },
    });
    await expect(client.callTool('collections.get', input)).rejects.toMatchObject({
      name: 'McpReadClientError',
      code: 'read_client_call_failed',
    });
    expect(gateway.callTool).not.toHaveBeenCalled();
    expect(presenter.displayToolCall).not.toHaveBeenCalled();
    expect(recorder.recordToolCall).toHaveBeenCalledOnce();
    expect(recorder.recordToolCall.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'collections.get',
      status: 'failed',
    });
  });

  it('Given non-enumerable collectionId, When calling tool, Then rejected and gateway idle', async () => {
    const hidden = Object.defineProperty({}, 'collectionId', {
      value: 'collection-1',
      enumerable: false,
    });
    const { client, gateway, recorder } = harness();
    await expect(client.callTool('collections.get', hidden)).rejects.toMatchObject({
      code: 'read_client_call_rejected',
    });
    expect(gateway.callTool).not.toHaveBeenCalled();
    expect(recorder.recordToolCall.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'collections.get',
      status: 'rejected',
    });
  });

  it('Given validator omits structuredContent, When calling tool, Then failed after gateway', async () => {
    const { client, gateway, presenter, recorder, resultValidator } = harness();
    resultValidator.validateToolResult.mockReturnValue(Object.freeze({}));
    await expect(client.callTool('collections.get', input)).rejects.toBeInstanceOf(McpReadClientError);
    expect(presenter.displayToolCall).toHaveBeenCalledOnce();
    expect(gateway.callTool).toHaveBeenCalledOnce();
    expect(resultValidator.validateToolResult).toHaveBeenCalledOnce();
    expect(recorder.recordToolCall.mock.calls[0]?.[0]).toMatchObject({
      status: 'failed',
      targetCollectionId: 'collection-1',
    });
  });
});

describe('U-2 gaps: stateless read core cursor/text/port [evidence:mcp.server-resource-safety]', () => {
  function readCoreHarness(overrides: Record<string, unknown> = {}) {
    const projection = {
      listResources: vi.fn(async () => ({ resources: [] })),
      readResource: vi.fn(async () => ({
        contents: [{
          mimeType: 'text/plain',
          text: 'ok',
          provenance: { origin: 'internal' },
        }],
      })),
      ...overrides,
    };
    const core = createMcpStatelessReadCore({
      projection,
      uriCodec: createMcpResourceUriCodec({ serverUuid }),
    });
    return { core, projection };
  }

  it('Given empty cursor string, When listing, Then McpResourceRequestError and list port idle', async () => {
    const { core, projection } = readCoreHarness();
    await expect(core.listResources(readContext(), { cursor: '' })).rejects.toMatchObject({
      name: 'McpResourceRequestError',
      code: 'resource_request_failed',
    });
    expect(projection.listResources).not.toHaveBeenCalled();
  });

  it('Given empty nextCursor from application, When listing, Then McpResourceRequestError', async () => {
    const { core, projection } = readCoreHarness({
      listResources: vi.fn(async () => ({
        resources: [{
          uri: metadataUri,
          name: 'Collection',
          mimeType: 'application/json',
          provenance: { origin: 'internal' },
        }],
        nextCursor: '',
      })),
    });
    await expect(core.listResources(readContext(), {})).rejects.toMatchObject({
      name: 'McpResourceRequestError',
      code: 'resource_request_failed',
    });
    expect(projection.listResources).toHaveBeenCalledOnce();
  });

  it('Given non-string text content, When reading, Then secret-free McpResourceRequestError', async () => {
    const secret = 'Bearer resource-text-secret';
    const { core, projection } = readCoreHarness({
      readResource: vi.fn(async () => ({
        contents: [{
          mimeType: 'text/plain',
          text: 42,
          provenance: { origin: 'external', sourceUri: `https://evil.example/${secret}` },
        }],
      })),
    });
    const error = await core.readResource(readContext(), { uri: metadataUri }).then(
      () => {
        throw new Error('expected reject');
      },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(McpResourceRequestError);
    expect(error).toMatchObject({ code: 'resource_request_failed' });
    expect(serialized(error)).not.toContain(secret);
    expect(projection.readResource).toHaveBeenCalledOnce();
  });

  it('Given a non-function projection port, When creating core, Then config TypeError', () => {
    expect(() =>
      createMcpStatelessReadCore({
        projection: { listResources: 'not-a-function' } as never,
        uriCodec: createMcpResourceUriCodec({ serverUuid }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      createMcpStatelessReadCore({
        projection: { listResources: vi.fn(), readResource: vi.fn() } as never,
        uriCodec: {} as never,
      }),
    ).toThrow(TypeError);
  });
});

describe('U-2 gaps: risk aggregation budget and visibility [evidence:mcp.risk-aggregation]', () => {
  it('Given set_visibility without object input, When assessing leaf, Then medium (not high)', () => {
    // Oracle: private/default visibility is medium; only public/unlisted escalate.
    expect(assessLeafTypeRisk('set_visibility', { input: 'public' as never })).toBe('medium');
    expect(assessLeafTypeRisk('set_visibility', {})).toBe('medium');
  });

  it('Given set_visibility unlisted, When assessing leaf and one-shot gate, Then high requires Plan', () => {
    expect(assessLeafTypeRisk('set_visibility', {
      input: { visibility: 'unlisted' },
    })).toBe('high');
    const operation = {
      type: 'set_visibility' as const,
      collectionId: 'collection-1',
      baseRevision: 'acl_17',
      input: { visibility: 'unlisted' as const },
    };
    expect(() => assertOneShotCanonicalOperationsAllowed([operation])).toThrow(
      McpHighRiskRequiresPlanError,
    );
  });

  it('Given nested operations at maxOperations boundary, When assessing tool call, Then budget error', () => {
    const nested = {
      items: [
        { type: 'nodes.create' },
        { type: 'nodes.create' },
      ],
    };
    const budget = {
      maxDepth: 8,
      maxNodes: 64,
      maxBytes: 65_536,
      maxOperations: 2,
    };
    expect(() => assessToolCallRisk('nodes.create', nested, budget)).toThrow(
      McpRiskAggregationError,
    );
    try {
      assessToolCallRisk('nodes.create', nested, budget);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_risk_input' });
    }
  });

  it('Given scalar children in items[], When expanding, Then scalars skipped and typed leaves kept', () => {
    const expanded = expandOperations({
      items: [null, 'ignored', 1, { type: 'nodes.create' }],
    });
    expect(expanded.some((item) => item.type === 'nodes.create')).toBe(true);
    expect(expanded.every((item) => typeof item.type === 'string')).toBe(true);
  });
});

describe('U-2 gaps: secret redaction Error/cause/model-facing [evidence:mcp.secret-redaction]', () => {
  it('Given model-facing content with password field, When redacting, Then field stripped and export works', () => {
    expect(typeof redactModelFacingStructuredContent).toBe('function');
    const redacted = redactModelFacingStructuredContent({
      title: 'Collection',
      password: 'credential-value',
      nested: { token: 'tok-secret', ok: true },
    });
    expect(redacted).toEqual({ title: 'Collection', nested: { ok: true } });
    expect(JSON.stringify(redacted)).not.toContain('credential-value');
    expect(JSON.stringify(redacted)).not.toContain('tok-secret');
    expect(structuredContentContainsSecret(redacted)).toBe(false);
  });

  it('Given keyId + token without reveal boundary, When model-facing redacting, Then public code and no token reflection', () => {
    const credential = 'tok-live-secret-value';
    try {
      redactModelFacingStructuredContent({ keyId: 'key_u2', token: credential, title: 'Key' });
      throw new Error('expected reject');
    } catch (error) {
      expect(error).toBeInstanceOf(McpSecretRedactionError);
      expect(error).toMatchObject({ code: 'secret_redaction_failed' });
      expect(serialized(error)).not.toContain(credential);
      expect(serialized(error)).not.toContain('tok-live');
    }
  });

  it('Given keyId + token with reveal boundary, When commit redacting, Then secretAvailable without token', () => {
    const credential = 'tok-live-secret-value';
    const redacted = redactCommitStructuredContent(
      { keyId: 'key_u2', token: credential, title: 'Key' },
      {
        revealUriForKey: (keyId) => `https://alice.example/collections/keys/${keyId}/reveal`,
        uriPolicy: allowAllUriPolicy,
      },
    );
    expect(redacted).toEqual({
      keyId: 'key_u2',
      title: 'Key',
      secretAvailable: true,
      revealUri: 'https://alice.example/collections/keys/key_u2/reveal',
    });
    expect(JSON.stringify(redacted)).not.toContain(credential);
  });

  it('Given symbol keys and non-enumerable secrets, When model-facing redacting, Then public fields kept', () => {
    const symbol = Symbol('credential');
    const value: Record<PropertyKey, unknown> = { title: 'ok' };
    value[symbol] = 'hidden-credential';
    Object.defineProperty(value, 'password', { value: 'hidden', enumerable: false });
    expect(redactModelFacingStructuredContent(value)).toEqual({ title: 'ok' });
  });

  it('Given Error with cause carrying credential, When wrapping redaction failure, Then public code only', () => {
    const credential = 'colp_live_cause_secret';
    let publicError: unknown;
    try {
      redactModelFacingStructuredContent({ keyId: 'key_u2', apiKey: credential });
    } catch (error) {
      publicError = error;
    }
    expect(publicError).toBeInstanceOf(McpSecretRedactionError);
    const wrapper = new Error('host wrapper');
    (wrapper as Error & { cause?: unknown }).cause = publicError;
    expect(wrapper.cause).toMatchObject({ code: 'secret_redaction_failed' });
    expect(serialized(wrapper)).not.toContain(credential);
    expect(serialized(publicError)).not.toContain(credential);
  });
});
