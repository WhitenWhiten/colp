import type { FastifyInstance } from 'fastify';
import { InMemoryMetrics } from '../../infrastructure/telemetry/index.js';
import { createMemoryMcpRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  createPhase4bMcpCompatOperations,
  createPhase4bMcpReadOperations,
  createPhase4bMcpResourceIdentity,
  mcpReadFeatureConfigAssertOptions,
  type Phase4bMcpReadOperations,
} from '../../modules/mcp/index.js';
import { registerMcpCompatRoutes } from './mcp-compat-routes.js';
import { registerMcpProtectedResourceRoutes } from './mcp-protected-resource-routes.js';
import { registerMcpReadRoutes } from './mcp-read-routes.js';
import { registerMcpWellKnownDiscoveryRoutes } from './mcp-well-known-routes.js';
import { registerMcpWriteApprovalRoutes } from './mcp-write-approval-routes.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from './mcp-strict-application-adapter.js';
import { createConnectionBudget } from './mcp-shared-admission.js';
import type { AppDependencies } from '../app.js';

export function registerMcpSurfaces(app: FastifyInstance, deps: AppDependencies): Phase4bMcpReadOperations | undefined {
  const {
    config,
    metrics = new InMemoryMetrics(),
    mcpWriteApprovalRoutes,
    mcpWriteOperations,
    mcpReadResourceProjection,
    mcpSnapshotResourceProjection,
    mcpNodeResourceProjection,
    mcpReadOperations,
    mcpCompatOperations,
    mcpReadTransport,
    mcpRateLimiter,
  } = deps;
  if (mcpWriteApprovalRoutes) {
    registerMcpWriteApprovalRoutes(app, mcpWriteApprovalRoutes);
  }
  if (mcpWriteOperations) {
    app.get('/ready/features/mcp-write', {
      config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    }, async (_request, reply) => {
      const result = await mcpWriteOperations.readiness();
      const payload = Object.freeze({
        capability: 'mcp-write',
        protocolVersion: '2026-07-28',
        status: result.status,
        reasons: result.reasons,
        counts: result.counts,
        ages: result.ages,
        retention: result.retention,
        limits: result.limits,
        enabled: result.enabled,
      });
      return reply.code(result.status === 'ready' ? 200 : 503).send(payload);
    });
  }
  let mcpOperations: Phase4bMcpReadOperations | undefined;
  if (config.mcp) {
    if (mcpReadResourceProjection === undefined) {
      throw new TypeError('MCP read resource projection is required when MCP Read is enabled');
    }
    if (mcpSnapshotResourceProjection === undefined) {
      throw new TypeError('MCP snapshot resource projection is required when MCP Read is enabled');
    }
    if (mcpNodeResourceProjection === undefined) {
      throw new TypeError('MCP node resource projection is required when MCP Read is enabled');
    }
    const operations = mcpReadOperations ?? createPhase4bMcpReadOperations({
      metrics,
      maxConcurrentRequests: config.mcp.budgets.request.maxConcurrent,
      maxQueuedRequests: config.mcp.budgets.request.maxQueue,
      maxListeners: config.mcp.budgets.listen.maxConnections,
      dependencyHealth: mcpReadTransport?.dependencyHealth,
    });
    mcpOperations = operations;
    app.get('/ready/features/mcp', {
      config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    }, async (_request, reply) => {
      const result = await operations.readiness();
      const payload = Object.freeze({
        capability: 'mcp',
        protocolVersion: '2026-07-28',
        status: result.status,
        reasons: result.reasons,
        counts: result.counts,
        limits: result.limits,
        listenLag: result.listenLag,
      });
      return reply.code(result.status === 'ready' ? 200 : 503).send(payload);
    });
    const mcpAssertOptions = mcpReadFeatureConfigAssertOptions({
      nodeEnv: config.nodeEnv,
      oauthIssuerEnabled: config.betterAuth.oauthIssuerEnabled,
    });
    registerMcpProtectedResourceRoutes(app, config.mcp, mcpAssertOptions);
    registerMcpWellKnownDiscoveryRoutes(app, config.mcp, mcpAssertOptions);
    const requestRateLimiter = mcpReadTransport?.requestRateLimiter
      ?? mcpRateLimiter
      ?? createMemoryMcpRateLimiter({ request: config.mcp.requestRateLimit });
    const requestConnectionBudget = mcpReadTransport?.requestConnectionBudget
      ?? createConnectionBudget(
        config.mcp.budgets.request.maxConcurrent,
        config.mcp.budgets.request.maxQueue,
      );
    const writeEnabled = config.mcpWriteEnabled === true;
    const applicationFacade = mcpReadTransport?.applicationFacade
      ?? (mcpReadTransport?.readToolAdapter === undefined
        ? undefined
        : createPhase4bMcpApplicationFacadeFromColpAdapters({
          resourceIdentity: createPhase4bMcpResourceIdentity(config.mcp, mcpAssertOptions),
          collectionProjection: mcpReadResourceProjection,
          snapshotProjection: mcpSnapshotResourceProjection,
          nodeProjection: mcpNodeResourceProjection,
          readToolAdapter: mcpReadTransport.readToolAdapter,
          ...(mcpReadTransport.writeToolAdapter === undefined
            ? {}
            : { writeToolAdapter: mcpReadTransport.writeToolAdapter }),
        }));
    if (config.mcp.compat !== undefined) {
      const compatOperations = mcpCompatOperations ?? createPhase4bMcpCompatOperations({
        metrics,
        maxConcurrentRequests: config.mcp.budgets.request.maxConcurrent,
        maxQueuedRequests: config.mcp.budgets.request.maxQueue,
        writeEnabled,
        oauthHealth: mcpReadTransport?.dependencyHealth,
        limiterHealth: () => (
          requestRateLimiter.readiness().status === 'healthy' ? 'ready' : 'unavailable'
        ),
        ...(writeEnabled
          ? {
            approvalHealth: async () => {
              if (mcpWriteOperations === undefined) return 'unavailable' as const;
              try {
                const result = await mcpWriteOperations.readiness();
                return result.reasons.includes('mcp_write_dependency_unavailable')
                  ? 'unavailable' as const
                  : 'ready' as const;
              } catch {
                return 'unavailable' as const;
              }
            },
          }
          : {}),
      });
      registerMcpCompatRoutes(app, config.mcp, {
        oauthVerifier: mcpReadTransport?.oauthVerifier,
        securityEpoch: mcpReadTransport?.securityEpoch,
        requestRateLimiter,
        requestConnectionBudget,
        compatOnAdmitted: mcpReadTransport?.compatOnAdmitted,
        compatOnSdkFactory: mcpReadTransport?.compatOnSdkFactory,
        ...(applicationFacade === undefined ? {} : { applicationFacade }),
        writeEnabled,
        operations: compatOperations,
        ...(mcpReadTransport?.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: mcpReadTransport.requestTimeoutMs }),
      });
    }
    registerMcpReadRoutes(app, config.mcp, {
      ...mcpReadTransport,
      requestRateLimiter,
      requestConnectionBudget,
      writeEnabled,
      operations,
      resourceProjection: mcpReadResourceProjection,
      nodeResourceProjection: mcpNodeResourceProjection,
      snapshotResourceProjection: mcpSnapshotResourceProjection,
      ...(applicationFacade === undefined ? {} : { applicationFacade }),
    }, mcpAssertOptions);
  }
  return mcpOperations;
}
