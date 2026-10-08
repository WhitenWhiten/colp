import { createLocalIssuerJwks } from '../infrastructure/auth/local-issuer-jwks.js';
import { createPostgresNodesSearchPorts } from '../infrastructure/search/index.js';
import { createSearchCursorSigner } from '../modules/search/index.js';
import { loadConfig, DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT } from './config.js';
import { createPhase4bMcpWriteComposition } from './mcp-write-composition.js';
import { createMcpReadOAuthTransportDependencies, createMcpSecurityEpochReader,
  type McpReadOAuthTransportDependenciesOptions } from './api-mcp-oauth-composition.js';
import {
  PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpSnapshotResourceProjection,
  createPhase4bMcpResourceIdentity,
  mcpReadFeatureConfigAssertOptions,
  type McpOauthRevocationStore,
  type McpApplicationFacade,
} from '../modules/mcp/index.js';
import { createPostgresMcpOwnedCollectionReadPort } from '../infrastructure/collections/index.js';
import {
  createPostgresMcpChangeSignalChannel,
  createPostgresMcpChangeSignalSource,
} from '../infrastructure/outbox/index.js';
import {
  createPostgresMcpOauthRevocationStore,
  createPostgresSharedExposureFactsPort,
  type DatabaseRuntime,
} from '../infrastructure/database/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../infrastructure/outbox/index.js';
import {
  createMemoryMcpRateLimiter,
  createMcpChangePlanCommitPort,
  createRedisMcpRateLimitStore,
  type McpRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';
import type { GetOwnedCollectionsPagePorts } from '../modules/collections/index.js';
import { composeCredentialGrantMcp, createCollectionGrantCommitGuard } from './account-credential-grant-composition.js';
import { createPostgresAccountCredentialUnitOfWork } from '../infrastructure/auth/account-credentials-postgres.js';
import type { AccountCredentialGrantRuntime } from '../infrastructure/auth/account-credentials-postgres.js';
import {
  composeAccountKeyRuntime,
  loadCredentialAuthority,
  resolveMachineMcpBinding,
} from '../modules/auth/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../transport/mcp/mcp-strict-application-adapter.js';
import { settleBestEffort } from '../infrastructure/async/best-effort.js';

export interface ApiMcpSurfaceComposition {
  readonly mcpCollectionResourceCursorKeys: ReturnType<typeof createPhase4bMcpCollectionResourceCursorKeyring> | undefined;
  readonly mcpChangeSignalSource: ReturnType<typeof createPostgresMcpChangeSignalSource> | undefined;
  readonly mcpReadResourceProjection: ReturnType<typeof createPhase4bMcpCollectionResourceProjection> | undefined;
  readonly mcpSnapshotResourceProjection: ReturnType<typeof createPhase4bMcpSnapshotResourceProjection> | undefined;
  readonly mcpNodeResourceProjection: ReturnType<typeof createPhase4bMcpNodeResourceProjection> | undefined;
  readonly mcpReadToolAdapter: ReturnType<typeof createPhase4bMcpReadToolAdapter> | undefined;
  readonly mcpOauthRevocationStore: McpOauthRevocationStore | undefined;
  readonly mcpReadOAuthDependencies: ReturnType<typeof createMcpReadOAuthTransportDependencies>;
  readonly mcpRateLimiter: McpRateLimiter | undefined;
  readonly mcpWriteComposition: ReturnType<typeof createPhase4bMcpWriteComposition> | undefined;
  readonly mcpApplicationFacade: McpApplicationFacade | undefined;
  readonly accountCredentialGrantRuntime?: AccountCredentialGrantRuntime;
}

export async function composeApiMcpSurface(input: {
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: DatabaseRuntime;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly metrics: Metrics;
  readonly publicationDirectoryReads: Parameters<typeof createPhase4bMcpCollectionResourceProjection>[0]['directoryQuery']['reads'];
  readonly publicationMetadataReads: Parameters<typeof createPhase4bMcpCollectionResourceProjection>[0]['metadataQuery']['reads'];
  readonly publicationCursorKeys: Parameters<typeof createPhase4bMcpCollectionResourceProjection>[0]['directoryQuery']['cursors'];
  readonly accessPolicyFacts: Parameters<typeof createPhase4bMcpCollectionResourceProjection>[0]['accessPolicy'];
  readonly publicationSnapshotQuery: Parameters<typeof createPhase4bMcpSnapshotResourceProjection>[0]['snapshotQuery'];
  readonly ownedCollectionsQuery?: GetOwnedCollectionsPagePorts;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly jwksProvider?: McpReadOAuthTransportDependenciesOptions['jwksProvider'];
  readonly governanceReportRateLimiter?: import('../transport/http-security.js').ProductAdmissionRateLimiter;
  readonly governanceActionRateLimiter?: import('../transport/http-security.js').ProductAdmissionRateLimiter;
  readonly governanceAppealRateLimiter?: import('../transport/http-security.js').ProductAdmissionRateLimiter;
}): Promise<ApiMcpSurfaceComposition> {
  const {
    config, database, identityUnitOfWork, metrics,
    publicationDirectoryReads, publicationMetadataReads, publicationCursorKeys,
    accessPolicyFacts, publicationSnapshotQuery, ownedCollectionsQuery,
    reportSourceInvalidation, jwksProvider, governanceReportRateLimiter,
  } = input;
  const mcpAssertOptions = mcpReadFeatureConfigAssertOptions({
    nodeEnv: config.nodeEnv,
    oauthIssuerEnabled: config.betterAuth.oauthIssuerEnabled,
  });
  let mcpCollectionResourceCursorKeys: ReturnType<typeof createPhase4bMcpCollectionResourceCursorKeyring> | undefined;
  if (config.mcp) {
    mcpCollectionResourceCursorKeys = createPhase4bMcpCollectionResourceCursorKeyring({
      ...config.mcp.collectionResources.cursorKeys,
      ttlMs: config.mcp.collectionResources.cursorTtlMs,
    });
  }
  const mcpChangeSignalSource = config.mcp
    ? createPostgresMcpChangeSignalSource({
        pool: database.pool,
        channel: createPostgresMcpChangeSignalChannel(config.mcp.serverUuid),
      })
    : undefined;
  let mcpRateLimiter: McpRateLimiter | undefined;
  try {
    if (mcpChangeSignalSource !== undefined) {
      await mcpChangeSignalSource.start();
    }
    const mcpReadResourceProjection = config.mcp && mcpCollectionResourceCursorKeys
      ? createPhase4bMcpCollectionResourceProjection({
          config: config.mcp,
          assertOptions: mcpAssertOptions,
          directoryQuery: {
            reads: publicationDirectoryReads,
            cursors: publicationCursorKeys,
            origin: config.publication.origin,
            maxPageSize: config.publication.maxPageSize,
          },
          metadataQuery: {
            reads: publicationMetadataReads,
            origin: config.publication.origin,
          },
          accessPolicy: accessPolicyFacts,
          cursorKeys: mcpCollectionResourceCursorKeys,
          now: () => new Date(),
          policyRevisionFor: async () => {
            const result = await database.pool.query<{ authority: string }>(
              `select count(*)::text || ':' || coalesce(max(policy_revision), 'none')
                      || ':' || coalesce(max(updated_at)::text, 'none') as authority
                 from collections`,
            );
            return result.rows[0]?.authority ?? 'none';
          },
          sharedExposure: createPostgresSharedExposureFactsPort(database),
        })
      : undefined;
  const mcpSnapshotResourceProjection = config.mcp
    ? createPhase4bMcpSnapshotResourceProjection({
        config: config.mcp,
        snapshotQuery: publicationSnapshotQuery,
        now: () => new Date(),
        assertOptions: mcpAssertOptions,
      })
    : undefined;
  const mcpNodeResourceProjection = config.mcp
    ? createPhase4bMcpNodeResourceProjection({
        config: config.mcp,
        snapshotQuery: publicationSnapshotQuery,
        now: () => new Date(),
        readLinkHealth: async (collectionId, nodeId) => {
          const row = await database.db.selectFrom('collection_link_health')
            .select('status')
            .where('collection_id', '=', collectionId)
            .where('node_id', '=', nodeId)
            .executeTakeFirst();
          return row?.status ?? null;
        },
      })
    : undefined;
  const mcpOwnedCollectionRead = config.mcp
    ? createPostgresMcpOwnedCollectionReadPort({
        db: database.db,
        accessPolicy: accessPolicyFacts,
      })
    : undefined;
  const mcpReadToolAdapter = config.mcp
    && mcpReadResourceProjection
    && mcpSnapshotResourceProjection
    && mcpNodeResourceProjection
    ? createPhase4bMcpReadToolAdapter({
        collectionProjection: mcpReadResourceProjection,
        snapshotProjection: mcpSnapshotResourceProjection,
        nodeProjection: mcpNodeResourceProjection,
        serverUuid: config.mcp.serverUuid,
        writeEnabled: config.mcpWriteEnabled === true,
        ...(mcpOwnedCollectionRead === undefined ? {} : { ownedRead: mcpOwnedCollectionRead }),
      })
    : undefined;
  let mcpOauthRevocationStore: McpOauthRevocationStore | undefined;
  if (config.nodeEnv === 'production' && config.mcp?.oauth.revocationStore === 'postgres') {
    // FIX-L-042: production opts into the shared PostgreSQL revocation store;
    // every replica reads the same revocation rows and the same epoch.
    mcpOauthRevocationStore = createPostgresMcpOauthRevocationStore({ db: database.db });
  }
  const accountKeyRuntime = composeAccountKeyRuntime({
    productOrigin: config.productOrigin,
    betterAuthBasePath: config.betterAuth.basePath,
    ...(config.mcp?.oauth.issuer ? { mcpIssuer: config.mcp.oauth.issuer } : {}),
    ...(config.mcp?.oauth.audience ? { mcpStrictAudience: config.mcp.oauth.audience } : {}),
    ...(config.mcp?.oauth.scopes ? { mcpScopes: config.mcp.oauth.scopes } : {}),
    privateJwk: config.accountCredentials.es256PrivateJwk,
    previousPublicJwks: config.accountCredentials.es256PreviousPublicJwks,
  });
  const machineCredentialUnitOfWork = config.accountCredentials.enabled
    ? createPostgresAccountCredentialUnitOfWork(database.db, undefined, undefined, { secretHmacKey: config.accountCredentials.cursorHmacKey?.toString('utf8') })
    : null;
  const builtinIssuer = `${config.productOrigin}${config.betterAuth.basePath}`;
  const localJwks = config.betterAuth.oauthIssuerEnabled
    && config.mcp?.oauth.issuer === builtinIssuer
    && config.mcp.oauth.jwksUri === `${builtinIssuer}/jwks`
      ? createLocalIssuerJwks(database.db, accountKeyRuntime.publicKeys) : undefined;
  const activeJwks = jwksProvider ?? localJwks;
  const mcpReadOAuthDependencies = createMcpReadOAuthTransportDependencies(config, {
    ...(activeJwks === undefined ? {} : { jwksProvider: activeJwks }),
    ...(mcpOauthRevocationStore === undefined
      ? {}
      : { revocationStore: mcpOauthRevocationStore }),
    resolveAccountBySubject: async (sub) => {
      const account = await identityUnitOfWork.execute((ports) => ports.accounts.findBySubjectId(sub));
      if (account === null || account.status !== 'active') return null;
      return { id: account.id, subjectId: account.subjectId, status: account.status, securityEpoch: account.securityEpoch.toString() };
    },
    ...(machineCredentialUnitOfWork && accountKeyRuntime.machineKids.size > 0
      ? {
          machine: {
            kids: accountKeyRuntime.machineKids,
            bind: (input) => resolveMachineMcpBinding({
              ...input,
              load: (credentialId) => machineCredentialUnitOfWork.execute(
                (ports) => loadCredentialAuthority(ports, credentialId),
              ),
            }),
          },
        }
      : {}),
  });
  // FIX-M-018: unified MCP rate-limit port (request / approval /
  // commit-distinct-plan). Production multi-replica injects the shared Redis
  // adapter (config gate + composition guard); single-instance production
  // and tests use the in-process adapter. The three named policies never
  // share a counter; every key is an HMAC over stable principal/client/
  // binding facts; Redis failures fail closed and report sanitized metrics.
  if (config.mcp !== undefined || config.mcpWriteEnabled) {
    const shared = config.mcpRateLimit;
    const request = config.mcp?.requestRateLimit ?? PHASE4B_MCP_CONFIG_DEFAULT_REQUEST_RATE_LIMIT;
    const approval = {
      maxRequests: config.httpSecurity.authRateLimit.maxRequests,
      windowMs: config.httpSecurity.authRateLimit.windowMs,
    };
    const commit = config.mcpWrite?.commitRateLimit ?? DEFAULT_MCP_WRITE_COMMIT_RATE_LIMIT;
    if (shared.enabled) {
      if (shared.redisUrl === null || shared.keySecret === null) {
        throw new Error(
          'API composition refused: MCP_RATE_LIMIT_SHARED=true requires MCP_RATE_LIMIT_REDIS_URL and MCP_RATE_LIMIT_KEY_SECRET',
        );
      }
      mcpRateLimiter = createRedisMcpRateLimitStore({
        redisUrl: shared.redisUrl,
        environment: config.nodeEnv,
        keySecret: shared.keySecret,
        keyPrefix: shared.keyPrefix,
        request,
        approval,
        commit,
        commandTimeoutMs: shared.commandTimeoutMs,
        connectTimeoutMs: shared.connectTimeoutMs,
        maxRetriesPerRequest: shared.maxRetriesPerRequest,
        // Sanitized failure observability: sealed policy + failure-class
        // labels only — never facts, keys, plans or secrets.
        onFailure: (policy, failure) => {
          metrics.increment(`mcp.rate_limit.failure.${policy}.${failure.class}`);
        },
      });
    } else {
      mcpRateLimiter = createMemoryMcpRateLimiter({ request, approval, commit });
    }
  }
  let mcpWriteComposition: ReturnType<typeof createPhase4bMcpWriteComposition> | undefined;
  const grantMcp = composeCredentialGrantMcp({
    config,
    securityEpoch: createMcpSecurityEpochReader(config, mcpOauthRevocationStore),
  });
  const grantRuntime = grantMcp.grantRuntime;
  if (config.mcpWriteEnabled) {
    if (config.mcp === undefined || config.mcpWrite === undefined) {
      throw new Error('KNOWN_FEATURE_MCP_WRITE requires the complete MCP Read host and Write config closure');
    }
    if (mcpRateLimiter === undefined) {
      throw new Error('KNOWN_FEATURE_MCP_WRITE requires the unified MCP rate limiter');
    }
    mcpWriteComposition = createPhase4bMcpWriteComposition({
      db: database.db,
      serverUuid: config.mcp.serverUuid,
      approvalBaseUri: config.mcpWrite.approvalBaseUri,
      requestStateKey: config.mcpWrite.requestStateKey,
      allowedScopes: config.mcp.oauth.scopes,
      metrics,
      planTtlMilliseconds: config.mcpWrite.planTtlMilliseconds,
      // Shared commit-distinct-plan budget: one quota per binding across
      // replicas; exact replay of a known plan stays free, a FAILED store
      // check denies the commit (fail closed).
      rateLimit: createMcpChangePlanCommitPort(mcpRateLimiter),
      productOrigin: config.productOrigin,
      identityUnitOfWork,
      ...(reportSourceInvalidation === undefined
        ? {} : { reportSourceInvalidation }),
      ...(grantRuntime === undefined ? {} : {
        beforeBeginCommit: createCollectionGrantCommitGuard({ db: database.db, ...grantRuntime }),
      }),
    });
    grantMcp.bindCollectionPlanStore(mcpWriteComposition.store);
  }
  const nodesSearch = config.mcp
    ? createPostgresNodesSearchPorts({
        db: database.db,
        sharedExposure: createPostgresSharedExposureFactsPort(database),
        cursors: createSearchCursorSigner({
          current: config.productEditorCursor.current,
          previous: config.productEditorCursor.previous,
        }),
      })
    : undefined;
  const mcpApplicationFacade = config.mcp
    && mcpReadResourceProjection
    && mcpSnapshotResourceProjection
    && mcpNodeResourceProjection
    && mcpReadToolAdapter
    ? createPhase4bMcpApplicationFacadeFromColpAdapters({
      resourceIdentity: createPhase4bMcpResourceIdentity(config.mcp, mcpAssertOptions),
      collectionProjection: mcpReadResourceProjection,
      snapshotProjection: mcpSnapshotResourceProjection,
      nodeProjection: mcpNodeResourceProjection,
      readToolAdapter: mcpReadToolAdapter.adapter,
      ...(mcpWriteComposition === undefined ? {} : { writeToolAdapter: mcpWriteComposition.adapter }),
      ...(ownedCollectionsQuery === undefined ? {} : { ownedCollectionsQuery }),
      ...(nodesSearch === undefined ? {} : { nodesSearch }),
    })
    : undefined;
  return {
    mcpCollectionResourceCursorKeys,
    mcpChangeSignalSource,
    mcpReadResourceProjection,
    mcpSnapshotResourceProjection,
    mcpNodeResourceProjection,
    mcpReadToolAdapter,
    mcpOauthRevocationStore,
    mcpReadOAuthDependencies,
    mcpRateLimiter,
    mcpWriteComposition,
    mcpApplicationFacade,
    ...(grantRuntime === undefined ? {} : { accountCredentialGrantRuntime: grantRuntime }),
  };
  } catch (error) {
    if (mcpRateLimiter !== undefined) {
      await settleBestEffort(
        mcpRateLimiter.close(),
        'the original MCP API composition failure remains authoritative',
      );
    }
    if (mcpChangeSignalSource !== undefined) {
      await settleBestEffort(
        mcpChangeSignalSource.close(),
        'the original MCP API composition failure remains authoritative',
      );
    }
    try {
      mcpCollectionResourceCursorKeys?.destroy();
    } catch {
      // Preserve the startup error after best-effort secret-buffer cleanup.
    }
    await settleBestEffort(
      database.close(),
      'the original MCP API composition failure remains authoritative',
    );
    throw error;
  }
}
